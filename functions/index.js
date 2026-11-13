/**
 * Firebase Cloud Functions — Deta / 清心網球協會
 * functions/ codebase (default)
 *
 * Auth approach: Firebase Authentication + OIDC provider (oidc.line)
 * Frontend calls signInWithPopup(new OAuthProvider('oidc.line')) directly.
 * No custom token, no LIFF token verification needed here.
 *
 * This file is reserved for future server-side functions:
 *   - Admin: approve / block / resign members
 *   - Scheduled: expire monthly memberships
 *   - Triggers: on new member created → notify admin
 */

'use strict';

const crypto = require('crypto');
const admin     = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const {
  BOOKING_HOURS,
  DGPA_DATASET_ID,
  DGPA_DATASET_URL,
  dateParts: bookingCalendarDateParts,
  findDgpaDistribution,
  getBookingOpenHours,
  getFallbackCalendar,
  parseDgpaCalendarCsv,
} = require('./booking-holiday-service');

admin.initializeApp();

const bookingDb = admin.firestore();
const SERVER_TS = admin.firestore.FieldValue.serverTimestamp;
const ADMIN_ROLES = new Set(['owner', 'admin']);
const LEGACY_MEMBERSHIP_FALLBACK_END = '2026-12-31';
const GENERAL_DAILY_LIMIT_START = '2026-08-10';
const GENERAL_DAILY_LIMIT_MESSAGE =
  '一般會員每日最多可預約 2 小時（Hard A、Hard B 合併計算）。';
const EXTENSION_DURATION_MINUTES = 60;
const MEMBERSHIP_EXPIRY_CANCEL_REASON =
  '超過繳費會籍有效期限，此預約不成立。';
const VIOLATION_LIMIT = 3;
const VIOLATION_TYPES = new Set(['no_show', 'roster_mismatch', 'other']);
const VIOLATION_REASON_LABELS = {
  no_show: '預約未到，未取消也未告知',
  roster_mismatch: '預約名單與實際使用人員不符',
  other: '其他原因',
};
const MEMBERSHIP_PLANS = new Set([
  'annual_standard', 'annual_senior', 'monthly',
]);
const BACKFILL_MEMBERSHIP_PLANS = new Set([
  ...MEMBERSHIP_PLANS, 'annual_unclassified',
]);

function bookingHolidayCalendarRef(year) {
  return bookingDb.collection('bookingHolidayCalendars').doc(String(year));
}

function bookingHolidayOverrideRef(date) {
  return bookingDb.collection('bookingHolidayOverrides').doc(date);
}

async function loadBookingHolidayContext(date, transaction) {
  const parts = bookingCalendarDateParts(date);
  if (!parts) throw new HttpsError('invalid-argument', '預約日期格式不正確');
  const calendarRef = bookingHolidayCalendarRef(parts.year);
  const overrideRef = bookingHolidayOverrideRef(date);
  const [calendarSnap, overrideSnap] = transaction ?
    await Promise.all([transaction.get(calendarRef), transaction.get(overrideRef)]) :
    await bookingDb.getAll(calendarRef, overrideRef);
  const fallback = getFallbackCalendar(parts.year);
  const calendar = calendarSnap.exists ?
    Object.assign({}, fallback, calendarSnap.data() || {}, {isFallback: false}) :
    fallback;
  return {
    calendar,
    override: overrideSnap.exists ? overrideSnap.data() || {} : null,
  };
}

async function assertBookingWithinOpenHours(
  date, startTime, endTime, transaction,
) {
  const context = await loadBookingHolidayContext(date, transaction);
  const hours = getBookingOpenHours(date, context.calendar, context.override);
  if (timeToMinutes(startTime) < timeToMinutes(hours.start) ||
      timeToMinutes(endTime) > timeToMinutes(hours.end)) {
    throw new HttpsError(
      'failed-precondition',
      `此日期場地開放時間為 ${hours.start}–${hours.end}，請重新選擇時段。`,
    );
  }
  return hours;
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function syncOfficialBookingCalendarYear(year, actorUid, source) {
  const metadataResponse = await fetchWithTimeout(DGPA_DATASET_URL);
  const metadata = await metadataResponse.json();
  const distribution = findDgpaDistribution(metadata, year);
  const csvResponse = await fetchWithTimeout(distribution.resourceDownloadUrl);
  const csvBytes = await csvResponse.arrayBuffer();
  const csvEncoding = String(distribution.resourceCharacterEncoding || '')
    .toUpperCase().includes('BIG5') ? 'big5' : 'utf-8';
  const csvText = new TextDecoder(csvEncoding).decode(csvBytes);
  const officialHolidayDates = parseDgpaCalendarCsv(csvText, year);
  const dataHash = crypto.createHash('sha256')
    .update(JSON.stringify(officialHolidayDates)).digest('hex');
  const calendarRef = bookingHolidayCalendarRef(year);
  const syncLogRef = bookingDb.collection('bookingHolidaySyncLogs').doc();
  const batch = bookingDb.batch();
  batch.set(calendarRef, {
    year,
    timezone: 'Asia/Taipei',
    officialHolidayDates,
    source: '行政院人事行政總處',
    sourceDatasetId: String(DGPA_DATASET_ID),
    sourceUrl: distribution.resourceDownloadUrl,
    sourceRevision: distribution.resourceQualityCheckTime || '',
    dataHash,
    lastSuccessfulSyncAt: SERVER_TS(),
    lastSuccessfulSyncBy: actorUid || 'scheduler',
    lastSuccessfulSyncSource: source || 'scheduler',
    syncStatus: 'success',
  }, {merge: true});
  batch.set(syncLogRef, {
    year,
    status: 'success',
    holidayCount: officialHolidayDates.length,
    dataHash,
    actorUid: actorUid || 'scheduler',
    source: source || 'scheduler',
    createdAt: SERVER_TS(),
  });
  await batch.commit();
  return {year, holidayCount: officialHolidayDates.length, dataHash};
}

async function runBookingHolidaySync(years, actorUid, source) {
  const results = [];
  for (const year of years) {
    try {
      results.push(Object.assign(
        {ok: true},
        await syncOfficialBookingCalendarYear(year, actorUid, source),
      ));
    } catch (error) {
      await bookingDb.collection('bookingHolidaySyncLogs').add({
        year,
        status: 'failed',
        error: cleanString(error && error.message, 500),
        actorUid: actorUid || 'scheduler',
        source: source || 'scheduler',
        createdAt: SERVER_TS(),
      });
      results.push({year, ok: false, error: error && error.message || 'sync failed'});
    }
  }
  return results;
}

function currentTaipeiYear() {
  return Number(new Intl.DateTimeFormat('en', {
    year: 'numeric',
    timeZone: 'Asia/Taipei',
  }).format(new Date()));
}

function taipeiDateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Asia/Taipei',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function cleanString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normaliseMemberName(value) {
  return cleanString(value, 100)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-TW');
}

function shouldDetectDuplicateMember(before, after, beforeExists) {
  if (!after || after.memberSource === 'manual') return false;
  const afterName = normaliseMemberName(after.realName);
  if (!afterName) return false;
  if (!beforeExists) return true;
  return normaliseMemberName(before && before.realName) !== afterName;
}

function duplicateMemberPairId(lineMemberUid, manualMemberUid) {
  return crypto.createHash('sha256')
    .update(`${lineMemberUid}\n${manualMemberUid}`, 'utf8')
    .digest('hex');
}

function duplicateMemberSnapshot(uid, member, source) {
  return {
    uid,
    realName: cleanString(member.realName, 50),
    displayName: cleanString(member.displayName, 50),
    role: cleanString(member.role, 30),
    status: cleanString(member.status, 30),
    membershipType: cleanString(member.membershipType, 30),
    membershipExpiry: normaliseExpiryDate(
      member.membershipExpiry || member.expireDate || '',
    ),
    approved: member.approved === true,
    memberSource: source,
    ntrp: member.ntrp == null ? '' : cleanString(String(member.ntrp), 10),
    preferredPosition: cleanString(member.preferredPosition, 20),
    createdAt: member.createdAt || null,
  };
}

function memberIdentityLinkRef(lineUid) {
  return bookingDb.collection('memberIdentityLinks').doc(lineUid);
}

async function resolveMemberIdentity(authUid, read) {
  const get = read || ((ref) => ref.get());
  const linkSnap = await get(memberIdentityLinkRef(authUid));
  let memberUid = authUid;
  let link = null;
  if (linkSnap.exists) {
    link = linkSnap.data() || {};
    if (link.status === 'active') {
      if (cleanString(link.lineUid, 200) !== authUid ||
          !cleanString(link.memberUid, 200)) {
        throw new HttpsError(
          'failed-precondition', '會員身分綁定資料不完整，請聯絡管理員',
        );
      }
      memberUid = cleanString(link.memberUid, 200);
    }
  }
  const memberRef = bookingDb.collection('members').doc(memberUid);
  const memberSnap = await get(memberRef);
  return {
    authUid,
    memberUid,
    memberRef,
    memberSnap,
    member: memberSnap.exists ? memberSnap.data() || {} : {},
    link,
  };
}

async function getAuthenticatedMember(request, read) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }
  const identity = await resolveMemberIdentity(request.auth.uid, read);
  if (!identity.memberSnap.exists) {
    throw new HttpsError('permission-denied', '找不到操作者會員資料');
  }
  return identity;
}

// 去敏化會員目錄：一般使用者只取得預約／教練選單所需公開欄位。
// 完整會員授權資料仍只能由本人或 Admin/Owner 透過 Firestore Rules 讀取。
exports.getMemberDirectory = onCall({region: 'asia-east1'}, async (request) => {
  const identity = await getAuthenticatedMember(request);
  const actor = identity.member || {};
  if (!isEligibleMember(actor)) {
    throw new HttpsError('permission-denied', '目前帳號無法讀取會員名錄');
  }
  const snapshot = await bookingDb.collection('members').get();
  const members = snapshot.docs
    .map((doc) => ({id: doc.id, data: doc.data() || {}}))
    .filter(({data}) => isEligibleMember(data) && !data.mergedInto)
    .map(({id, data}) => ({
      userId: id,
      uid: id,
      realName: cleanString(data.realName, 50),
      displayName: cleanString(data.displayName, 50),
      photoURL: cleanString(data.photoURL || data.pictureUrl, 500),
      role: cleanString(data.role, 20) || 'member',
      ntrp: data.ntrp == null ? '' : cleanString(String(data.ntrp), 10),
      preferredPosition: cleanString(data.preferredPosition, 20),
      status: 'approved',
    }));
  return {members};
});

function annualRosterExportStatus(periods, today) {
  const list = periods || [];
  if (list.length && list.every((period) => period.status === 'resigned')) {
    return 'resigned';
  }
  const usable = list.filter((period) =>
    !['revoked', 'cancelled', 'resigned'].includes(period.status));
  if (usable.some((period) =>
    (period.status === 'scheduled' && period.startDate && period.startDate <= today) ||
    (period.status !== 'scheduled' &&
      ['active', 'expired'].includes(period.status || 'active')))) {
    return 'qualified';
  }
  if (usable.some((period) => period.status === 'scheduled' ||
      (period.startDate && period.startDate > today))) {
    return 'scheduled';
  }
  return 'missing';
}

function buildAnnualRosterExportRows(periodItems, memberNames, today) {
  const grouped = new Map();
  (periodItems || []).forEach((item) => {
    const period = item.data || item || {};
    const memberUid = cleanString(period.memberUid, 128);
    if (!memberUid || ['revoked', 'cancelled'].includes(period.status)) return;
    if (!grouped.has(memberUid)) grouped.set(memberUid, []);
    grouped.get(memberUid).push(period);
  });
  return Array.from(grouped.entries()).map(([memberUid, periods]) => {
    const representative = periods.slice().sort((first, second) =>
      cleanString(second.expiryDate, 20)
        .localeCompare(cleanString(first.expiryDate, 20)))[0] || {};
    const expiryDate = periods.reduce((latest, period) => {
      const expiry = cleanString(period.expiryDate, 20);
      return expiry > latest ? expiry : latest;
    }, '');
    const status = annualRosterExportStatus(periods, today);
    return {
      memberName: cleanString(representative.memberName, 100) ||
        cleanString((memberNames || {})[memberUid], 100) || '未指定會員',
      membershipPlan: cleanString(representative.membershipPlan, 30),
      membershipPlanLabel: membershipPlanLabel(representative.membershipPlan),
      expiryDate,
      status,
      statusLabel: ({
        qualified: '正式會員',
        scheduled: '已繳待生效',
        resigned: '年度離會',
        missing: '尚無年度紀錄',
      })[status] || '尚無年度紀錄',
    };
  }).sort((first, second) =>
    first.memberName.localeCompare(second.memberName, 'zh-Hant'));
}

// 年度名冊匯出只由後端提供必要欄位；不回傳 UID、電話、Email 或 LINE 資料。
exports.getAnnualMemberRosterExport = onCall(
  {region: 'asia-east1'}, async (request) => {
    const identity = await getAuthenticatedMember(request);
    if (!ADMIN_ROLES.has(identity.member.role || '')) {
      throw new HttpsError('permission-denied', '僅 Owner／Admin 可匯出年度會員名冊');
    }
    const membershipYear = Number((request.data || {}).membershipYear);
    if (!Number.isInteger(membershipYear) || membershipYear < 2026 ||
        membershipYear > 2100) {
      throw new HttpsError('invalid-argument', '會員年度不正確');
    }
    const snapshot = await bookingDb.collection('membershipPeriods')
      .where('membershipYear', '==', membershipYear).get();
    const periodItems = snapshot.docs.map((doc) => ({
      id: doc.id,
      data: doc.data() || {},
    }));
    const memberUids = Array.from(new Set(periodItems
      .map((item) => cleanString(item.data.memberUid, 128))
      .filter(Boolean)));
    const memberNames = {};
    if (memberUids.length) {
      const memberSnaps = await bookingDb.getAll(...memberUids.map((memberUid) =>
        bookingDb.collection('members').doc(memberUid)));
      memberSnaps.forEach((memberSnap) => {
        if (!memberSnap.exists) return;
        const member = memberSnap.data() || {};
        memberNames[memberSnap.id] = cleanString(
          member.realName || member.displayName, 100,
        );
      });
    }
    return {
      membershipYear,
      rows: buildAnnualRosterExportRows(
        periodItems, memberNames, taipeiDateString(),
      ),
      generatedAt: new Date().toISOString(),
    };
  },
);

// 本人重新送審改由後端限制狀態轉移，避免 client 可任意修改 status。
exports.requestMemberReapproval = onCall(
  {region: 'asia-east1'}, async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
    }
    await bookingDb.runTransaction(async (transaction) => {
      const identity = await getAuthenticatedMember(
        request, (ref) => transaction.get(ref),
      );
      const status = cleanString(identity.member.status, 30);
      if (!['deleted', 'removed', 'expired', 'inactive'].includes(status)) {
        throw new HttpsError('failed-precondition', '目前狀態無法重新申請');
      }
      transaction.update(identity.memberRef, {
        status: 'pending',
        reappliedAt: SERVER_TS(),
        updatedAt: SERVER_TS(),
      });
    });
    return {ok: true};
  },
);

function isActiveBooking(booking) {
  const status = booking.status || 'active';
  return status === 'active' || status === 'confirmed';
}

function isEligibleMember(member) {
  if (!member) return false;
  if (['deleted', 'merged', 'blocked', 'resigned', 'rejected', 'pending']
    .includes(member.status || '') || member.mergedInto) return false;
  if (ADMIN_ROLES.has(member.role || '')) {
    return true;
  }
  return member.status === 'active' ||
    member.status === 'approved' ||
    member.approved === true;
}

function bookingStartMs(booking) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(booking.date || '');
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(booking.startTime || '');
  if (!dateMatch || !timeMatch) return NaN;
  return Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]) - 8,
    Number(timeMatch[2]),
  );
}

function normaliseBookingMode(mode) {
  return {
    normal: 'general',
    lesson: 'teaching',
    coaching: 'teaching',
    group_class: 'groupClass',
  }[mode] || mode || 'general';
}

function bookingSubjectUid(booking) {
  const mode = normaliseBookingMode(booking.mode);
  if (mode === 'general' || mode === 'pickleball') {
    return Array.isArray(booking.players) && booking.players[0] ||
      booking.createdBy || '';
  }
  if (mode === 'teaching' || mode === 'groupClass') {
    return booking.coachId || booking.createdBy || '';
  }
  return '';
}

function normaliseExpiryDate(value) {
  const expiry = cleanString(value, 10).replace(/\//g, '-');
  return /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : '';
}

function hasValidMembershipForBooking(member, date) {
  return evaluateMembershipAccess(member, date, [], {
    allowAdminOverride: true,
  }).allowed;
}

function evaluateMembershipAccess(member, date, periods, options) {
  options = options || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return {allowed: false, reason: 'invalid_date', source: ''};
  }
  if (!isEligibleMember(member)) {
    return {allowed: false, reason: 'account_ineligible', source: ''};
  }
  const role = member.role || '';
  if (options.allowAdminOverride !== false && ADMIN_ROLES.has(role)) {
    return {allowed: true, reason: '', source: 'admin_override', expiry: ''};
  }
  const validPeriods = (periods || []).filter((period) => {
    const status = period.status || '';
    return !['revoked', 'resigned', 'cancelled'].includes(status) &&
      /^\d{4}-\d{2}-\d{2}$/.test(period.startDate || '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(period.expiryDate || '') &&
      period.startDate <= date && date <= period.expiryDate;
  }).sort((a, b) => String(b.expiryDate).localeCompare(String(a.expiryDate)));
  if (validPeriods.length) {
    return {
      allowed: true, reason: '', source: 'membership_period',
      expiry: validPeriods[0].expiryDate,
    };
  }
  // Compatibility is deliberately limited to 2026. A members cache value
  // extending into 2027 must never grant 2027+ access without a period.
  if (date <= LEGACY_MEMBERSHIP_FALLBACK_END) {
    const expiry = normaliseExpiryDate(
      member.membershipExpiry || member.expireDate || '',
    );
    if (expiry && date <= expiry) {
      return {allowed: true, reason: '', source: 'legacy_2026', expiry};
    }
  }
  return {allowed: false, reason: 'no_active_period', source: ''};
}

async function membershipExpiryForBooking(memberUid, member, date) {
  const periods = await bookingDb.collection('membershipPeriods')
    .where('memberUid', '==', memberUid).get();
  const access = evaluateMembershipAccess(
    member, date, periods.docs.map((doc) => doc.data() || {}),
  );
  return access.allowed ? access.expiry || date : '';
}

async function assertMemberHasBookingAccess(memberUid, member, date) {
  const expiry = await membershipExpiryForBooking(memberUid, member, date);
  if (!expiry) {
    const name = memberDisplayName(member, memberUid);
    throw new HttpsError(
      'failed-precondition',
      `${name}於此日期沒有有效會員資格，無法預約。`,
    );
  }
  return expiry;
}

async function assertMembersHaveBookingAccess(memberUids, date) {
  const uids = [...new Set((memberUids || []).filter(Boolean))];
  if (!uids.length) return;
  const snaps = await bookingDb.getAll(...uids.map((uid) =>
    bookingDb.collection('members').doc(uid)));
  await Promise.all(snaps.map(async (snap, index) => {
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', '找不到預約會員資料');
    }
    await assertMemberHasBookingAccess(uids[index], snap.data() || {}, date);
  }));
}

async function assertMembersHaveBookingAccessInTransaction(
  transaction, memberUids, date,
) {
  const uids = [...new Set((memberUids || []).filter(Boolean))];
  for (const uid of uids) {
    const memberRef = bookingDb.collection('members').doc(uid);
    const memberSnap = await transaction.get(memberRef);
    if (!memberSnap.exists) {
      throw new HttpsError('failed-precondition', '找不到預約會員資料');
    }
    const periodsSnap = await transaction.get(
      bookingDb.collection('membershipPeriods').where('memberUid', '==', uid),
    );
    const member = memberSnap.data() || {};
    const access = evaluateMembershipAccess(
      member, date, periodsSnap.docs.map((doc) => doc.data() || {}),
    );
    if (!access.allowed) {
      throw new HttpsError(
        'failed-precondition',
        `${memberDisplayName(member, uid)}於此日期沒有有效會員資格，無法預約。`,
      );
    }
  }
}

async function assertSelectedTeachingStudentsEligible(studentUids, date) {
  const selected = [...new Set((studentUids || []).filter(Boolean))];
  if (!selected.length) return;
  const snaps = await bookingDb.getAll(...selected.map((uid) =>
    bookingDb.collection('members').doc(uid)));
  const checks = await Promise.all(snaps.map(async (snap, index) => {
    const member = snap.exists ? snap.data() || {} : {};
    const expiry = snap.exists ? await membershipExpiryForBooking(
      selected[index], member, date,
    ) : '';
    return expiry ? '' : member.realName || member.name ||
      member.displayName || selected[index];
  }));
  const invalidNames = checks.filter(Boolean);
  if (invalidNames.length) {
    throw new HttpsError(
      'failed-precondition',
      `${invalidNames.join('、')} 目前無有效會籍，無法建立教學預約。\n\n` +
        '請先完成繳費並聯繫協會更新會籍。',
    );
  }
}

function timeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function bookingEndMs(booking) {
  return bookingStartMs(Object.assign({}, booking, {
    startTime: booking.endTime,
  }));
}

function bookingIntervalsOverlap(first, second) {
  const firstStart = bookingStartMs(first);
  const firstEnd = bookingEndMs(first);
  const secondStart = bookingStartMs(second);
  const secondEnd = bookingEndMs(second);
  return Number.isFinite(firstStart) && Number.isFinite(firstEnd) &&
    Number.isFinite(secondStart) && Number.isFinite(secondEnd) &&
    firstStart < secondEnd && firstEnd > secondStart;
}

function bookingParticipantUids(booking) {
  const uids = [];
  if (booking.coachId) uids.push(booking.coachId);
  if (Array.isArray(booking.players)) uids.push(...booking.players);
  if (Array.isArray(booking.students)) uids.push(...booking.students);
  return [...new Set(uids.filter((uid) =>
    typeof uid === 'string' && uid))];
}

function findCourtConflict(bookings, candidate, excludeId) {
  return bookings.find((booking) =>
    booking.id !== excludeId &&
    isActiveBooking(booking) &&
    booking.court === candidate.court &&
    bookingIntervalsOverlap(booking, candidate)) || null;
}

function findParticipantConflictUid(bookings, candidate, excludeId) {
  const candidateUids = new Set(bookingParticipantUids(candidate));
  if (!candidateUids.size) return '';
  for (const booking of bookings) {
    if (booking.id === excludeId || !isActiveBooking(booking) ||
        !bookingIntervalsOverlap(booking, candidate)) continue;
    const conflictUid = bookingParticipantUids(booking)
      .find((uid) => candidateUids.has(uid));
    if (conflictUid) return conflictUid;
  }
  return '';
}

function shouldBypassParticipantConflict(actorRole, mode) {
  return actorRole === 'owner' &&
    ['groupClass', 'event_lock'].includes(normaliseBookingMode(mode));
}

function generalMinutesForUid(bookings, uid) {
  return bookings.reduce((total, booking) => {
    if (!isActiveBooking(booking) ||
        normaliseBookingMode(booking.mode) !== 'general' ||
        (booking.court !== 'hard_a' && booking.court !== 'hard_b') ||
        !generalBookingPlayerUids(booking).includes(uid)) return total;
    const duration = timeToMinutes(booking.endTime) -
      timeToMinutes(booking.startTime);
    return Number.isFinite(duration) && duration > 0 ? total + duration : total;
  }, 0);
}

function normalGeneralMinutesForUid(bookings, uid) {
  return generalMinutesForUid(
    bookings.filter((booking) => booking.extensionStatus !== 'approved'),
    uid,
  );
}

function hasApprovedExtension(bookings, uid) {
  return bookings.some((booking) =>
    isActiveBooking(booking) &&
    booking.extensionStatus === 'approved' &&
    generalBookingPlayerUids(booking).includes(uid));
}

function extensionRequestDocId(uid, date) {
  return `${encodeURIComponent(uid)}_${date}`;
}

function bookingDateLockId(date) {
  return date;
}

function memberDisplayName(member, fallback) {
  return cleanString(
    member.realName || member.name || member.displayName || fallback,
    100,
  );
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function addTaipeiCalendarMonth(nowMillis) {
  const taipeiOffset = 8 * 60 * 60 * 1000;
  const shifted = new Date(nowMillis + taipeiOffset);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const millis = shifted.getUTCMilliseconds();
  const lastTargetDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return Date.UTC(
    year, month + 1, Math.min(day, lastTargetDay),
    hour, minute, second, millis,
  ) - taipeiOffset;
}

function formatTaipeiDate(value) {
  const millis = timestampMillis(value);
  if (!millis) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(millis));
}

function violationSummaryRef(memberUid) {
  return bookingDb.collection('bookingViolationSummaries').doc(memberUid);
}

function violationAuditData({
  action, actorUid, actorName, targetUid, targetName, bookingId,
  violationId, before, after, reason, source,
}) {
  return {
    action,
    actorUid: actorUid || '',
    actorName: actorName || '',
    targetUid: targetUid || '',
    targetName: targetName || '',
    bookingId: bookingId || '',
    violationId: violationId || '',
    before: before || null,
    after: after || null,
    reason: reason || '',
    timestamp: SERVER_TS(),
    source: source || 'web_callable',
  };
}

function violationNotificationData(
  violation, activePoints, suspendedAt, suspendedUntil,
) {
  const suspended = Boolean(suspendedUntil);
  const bookingTime = violation.startTime && violation.endTime ?
    `${violation.startTime}–${violation.endTime}` : '';
  const details = [
    `違規記點 +1`,
    `違規原因：${violation.violationReason}`,
  ];
  if (violation.note) details.push(`備註：${violation.note}`);
  if (violation.bookingDate) {
    details.push(
      `預約：${violation.bookingDate} ${bookingTime} ${courtLabel(violation.court)}`.trim(),
    );
  }
  details.push(`記點人員：${violation.createdByName}`);
  details.push(`記點時間：${new Date().toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}`);
  details.push(`目前有效點數：${activePoints} / ${VIOLATION_LIMIT}`);
  if (suspended) {
    details.push('已累積 3 點，自即日起暫停預約資格 1 個月。');
    details.push(`停權開始時間：${new Date(suspendedAt).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}`);
    details.push(`停權截止時間：${new Date(suspendedUntil).toLocaleString('zh-TW', {timeZone: 'Asia/Taipei'})}`);
  }
  return {
    uid: violation.memberUid,
    type: suspended ? 'booking_suspension_started' : 'booking_violation_recorded',
    action: 'violation_create',
    title: suspended ? '違規記點與預約停權通知' : '違規記點通知',
    violationId: violation.id,
    bookingId: violation.bookingId || '',
    violationType: violation.violationType,
    violationReason: violation.violationReason,
    note: violation.note || '',
    date: violation.bookingDate || '',
    startTime: violation.startTime || '',
    endTime: violation.endTime || '',
    court: violation.court || '',
    courtLabel: courtLabel(violation.court),
    recordedByUid: violation.createdByUid,
    recordedByName: violation.createdByName,
    activePoints,
    suspensionStartedAt: suspended ?
      admin.firestore.Timestamp.fromMillis(suspendedAt) : null,
    suspensionUntil: suspended ?
      admin.firestore.Timestamp.fromMillis(suspendedUntil) : null,
    message: details.join('\n'),
    createdAt: SERVER_TS(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ),
    read: false,
  };
}

async function normaliseExpiredViolationCycle(
  memberUid, actorUid, actorName, source,
) {
  const summaryRef = violationSummaryRef(memberUid);
  await bookingDb.runTransaction(async (transaction) => {
    const summarySnap = await transaction.get(summaryRef);
    if (!summarySnap.exists) return;
    const summary = summarySnap.data() || {};
    const suspendedUntilMs = timestampMillis(summary.bookingSuspendedUntil);
    if (summary.status !== 'suspended' ||
        !suspendedUntilMs || suspendedUntilMs > Date.now()) return;
    const before = {
      cycleId: summary.cycleId || '',
      activePoints: Number(summary.activePoints) || 0,
      bookingSuspendedAt: summary.bookingSuspendedAt || null,
      bookingSuspendedUntil: summary.bookingSuspendedUntil || null,
    };
    transaction.set(summaryRef, {
      memberUid,
      memberName: summary.memberName || '',
      cycleId: '',
      cycleViolationIds: [],
      activePoints: 0,
      status: 'active',
      cycleStartedAt: null,
      bookingSuspendedAt: null,
      bookingSuspendedUntil: null,
      suspensionTriggerViolationId: '',
      suspensionEndedAt: SERVER_TS(),
      lastCompletedCycleId: summary.cycleId || '',
      updatedAt: SERVER_TS(),
    }, {merge: true});
    transaction.set(
      bookingDb.collection('bookingViolationAuditLogs').doc(),
      violationAuditData({
        action: 'suspension_end',
        actorUid,
        actorName,
        targetUid: memberUid,
        targetName: summary.memberName || '',
        violationId: summary.suspensionTriggerViolationId || '',
        before,
        after: {cycleId: '', activePoints: 0, status: 'active'},
        reason: '預約停權期限已屆滿，目前週期有效點數歸零',
        source,
      }),
    );
  });
}

function suspendedBookingError(memberUid, memberName, suspendedUntil, action) {
  const untilLabel = formatTaipeiDate(suspendedUntil);
  return new HttpsError(
    'failed-precondition',
    `因累積 3 點預約違規，目前暫停預約資格至 ${untilLabel}。`,
    {
      suspensionRejected: true,
      memberUid,
      memberName,
      suspendedUntil: timestampMillis(suspendedUntil),
      action,
    },
  );
}

async function assertPlayersNotSuspendedInTransaction(
  transaction, playerUids, action,
) {
  const uniqueUids = [...new Set((playerUids || []).filter(Boolean))];
  for (const memberUid of uniqueUids) {
    const summarySnap = await transaction.get(violationSummaryRef(memberUid));
    if (!summarySnap.exists) continue;
    const summary = summarySnap.data() || {};
    const untilMs = timestampMillis(summary.bookingSuspendedUntil);
    if (summary.status === 'suspended' && untilMs > Date.now()) {
      throw suspendedBookingError(
        memberUid, summary.memberName || memberUid,
        summary.bookingSuspendedUntil, action,
      );
    }
  }
}

async function assertPlayersNotSuspended(playerUids, action) {
  const uniqueUids = [...new Set((playerUids || []).filter(Boolean))];
  for (const memberUid of uniqueUids) {
    const summarySnap = await violationSummaryRef(memberUid).get();
    if (!summarySnap.exists) continue;
    const summary = summarySnap.data() || {};
    const untilMs = timestampMillis(summary.bookingSuspendedUntil);
    if (summary.status === 'suspended' && untilMs > Date.now()) {
      throw suspendedBookingError(
        memberUid, summary.memberName || memberUid,
        summary.bookingSuspendedUntil, action,
      );
    }
  }
}

async function recordSuspensionRejection(
  error, actorUid, actorName, bookingId, source,
) {
  const details = error && error.details || {};
  if (!details.suspensionRejected) return;
  await bookingDb.collection('bookingViolationAuditLogs').add(
    violationAuditData({
      action: details.action,
      actorUid,
      actorName,
      targetUid: details.memberUid,
      targetName: details.memberName,
      bookingId,
      reason: error.message || '停權中的會員不得建立或加入預約',
      after: {bookingSuspendedUntil: details.suspendedUntil || null},
      source,
    }),
  );
}

async function assertPlayersNotSuspendedAndAudit(
  playerUids, action, actorUid, actorName, bookingId, source,
) {
  try {
    await assertPlayersNotSuspended(playerUids, action);
  } catch (error) {
    await recordSuspensionRejection(
      error, actorUid, actorName, bookingId, source,
    );
    throw error;
  }
}

function courtLabel(court) {
  return {
    hard_a: 'Hard A',
    hard_b: 'Hard B',
    clay_a: 'Clay A',
    clay_b: 'Clay B',
  }[court] || court || '';
}

function assertExtensionTimeInput(date, court, startTime, endTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      (court !== 'hard_a' && court !== 'hard_b') ||
      !Number.isFinite(timeToMinutes(startTime)) ||
      !Number.isFinite(timeToMinutes(endTime)) ||
      timeToMinutes(endTime) - timeToMinutes(startTime) !==
        EXTENSION_DURATION_MINUTES) {
    throw new HttpsError(
      'invalid-argument',
      '加時申請必須指定 Hard A 或 Hard B 的完整 1 小時時段。',
    );
  }
}

function assertExtensionMemberEligible(memberUid, member, date) {
  // Keep the pure two-argument form for existing unit coverage.
  if (typeof memberUid === 'object') {
    date = member;
    member = memberUid;
    if (!isEligibleMember(member) ||
        (!ADMIN_ROLES.has(member.role || '') &&
         !hasValidMembershipForBooking(member, date))) {
      throw new HttpsError(
        'failed-precondition', '會員會籍無法涵蓋申請日期，無法申請加時。',
      );
    }
    return;
  }
  if (!isEligibleMember(member)) {
    throw new HttpsError('failed-precondition', '會員目前不具有效資格');
  }
  if (ADMIN_ROLES.has(member.role || '')) return Promise.resolve();
  return membershipExpiryForBooking(memberUid, member, date).then((expiry) => {
    if (!expiry) {
      throw new HttpsError(
        'failed-precondition',
        '會員會籍無法涵蓋申請日期，無法申請加時。',
      );
    }
  });
}

function generalBookingPlayerUids(booking) {
  const players = Array.isArray(booking.players) ? booking.players : [];
  const uids = players.filter((uid) => typeof uid === 'string' && uid);
  if (!uids.length && booking.createdBy) uids.push(booking.createdBy);
  return [...new Set(uids)];
}

function findGeneralDailyLimitExceededUid(bookings, booking, excludeId) {
  if (booking.date < GENERAL_DAILY_LIMIT_START ||
      normaliseBookingMode(booking.mode) !== 'general' ||
      (booking.court !== 'hard_a' && booking.court !== 'hard_b')) {
    return '';
  }
  const playerUids = generalBookingPlayerUids(booking);
  if (!playerUids.length) return '';
  const duration = timeToMinutes(booking.endTime) -
    timeToMinutes(booking.startTime);
  if (!Number.isFinite(duration) || duration <= 0) return playerUids[0];
  const totals = new Map(playerUids.map((uid) => [uid, duration]));
  bookings.forEach((existing) => {
    if (existing.id === excludeId ||
        !isActiveBooking(existing) ||
        existing.extensionStatus === 'approved' ||
        normaliseBookingMode(existing.mode) !== 'general' ||
        (existing.court !== 'hard_a' && existing.court !== 'hard_b')) return;
    const existingDuration = timeToMinutes(existing.endTime) -
      timeToMinutes(existing.startTime);
    if (!Number.isFinite(existingDuration) || existingDuration <= 0) return;
    const existingPlayers = new Set(generalBookingPlayerUids(existing));
    playerUids.forEach((uid) => {
      if (existingPlayers.has(uid)) totals.set(uid, totals.get(uid) + existingDuration);
    });
  });
  return playerUids.find((uid) => totals.get(uid) > 120) || '';
}

async function assertGeneralDailyLimitAllowed(bookings, booking, excludeId) {
  const exceededUid = findGeneralDailyLimitExceededUid(
    bookings, booking, excludeId,
  );
  if (!exceededUid) return;
  const memberSnap = await bookingDb.collection('members').doc(exceededUid).get();
  const member = memberSnap.exists ? memberSnap.data() || {} : {};
  const name = member.realName || member.name ||
    member.displayName || exceededUid;
  throw new HttpsError(
    'failed-precondition',
    `${name}今日一般場地使用時間將超過 2 小時，無法建立預約。`,
  );
}

function assertHardCourtUsageAllowed(
  bookings, subjectUid, startTime, endTime, excludeId,
) {
  const intervals = bookings
    .filter((booking) => {
      return booking.id !== excludeId &&
        isActiveBooking(booking) &&
        (booking.court === 'hard_a' || booking.court === 'hard_b') &&
        bookingSubjectUid(booking) === subjectUid;
    })
    .map((booking) => ({
      start: timeToMinutes(booking.startTime),
      end: timeToMinutes(booking.endTime),
    }));
  intervals.push({
    start: timeToMinutes(startTime),
    end: timeToMinutes(endTime),
  });
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks = [];
  intervals.forEach((interval) => {
    if (!Number.isFinite(interval.start) ||
        !Number.isFinite(interval.end) ||
        interval.end <= interval.start) {
      throw new HttpsError('invalid-argument', '預約時間格式不正確');
    }
    const last = blocks[blocks.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      blocks.push({start: interval.start, end: interval.end});
    }
  });

  for (let i = 0; i < blocks.length; i += 1) {
    const duration = blocks[i].end - blocks[i].start;
    if (duration > 120 ||
        (duration === 120 && blocks[i + 1] &&
         blocks[i + 1].start - blocks[i].end < 60)) {
      throw new HttpsError(
        'failed-precondition',
        '硬地每人連續預約最多 2 小時，使用滿 2 小時後需間隔 1 小時方可再次預約。',
      );
    }
  }
}

async function getBookingActorContext(request) {
  const identity = await getAuthenticatedMember(request);
  const actorUid = identity.memberUid;
  const actor = identity.member;

  const bookingId = cleanString((request.data || {}).bookingId, 128);
  if (!bookingId) {
    throw new HttpsError('invalid-argument', 'bookingId 必填');
  }
  const bookingRef = bookingDb.collection('bookings').doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) {
    throw new HttpsError('not-found', '找不到此預約');
  }
  const booking = bookingSnap.data() || {};

  const actorRole = actor.role || '';
  const isManager = booking.createdBy === actorUid ||
    ADMIN_ROLES.has(actorRole);
  if (!isManager) {
    throw new HttpsError('permission-denied', '只有預約建立者或管理員可執行此操作');
  }
  if (!isEligibleMember(actor)) {
    throw new HttpsError('permission-denied', '操作者目前不具有效會員資格');
  }

  return {
    actor,
    actorRole,
    actorUid,
    booking,
    bookingId,
    bookingRef,
  };
}

exports.getBookingHolidayCalendar = onCall(
  {region: 'asia-east1'},
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
    }
    const year = Number(request.data && request.data.year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      throw new HttpsError('invalid-argument', '年度格式不正確');
    }
    const calendarSnap = await bookingHolidayCalendarRef(year).get();
    const fallback = getFallbackCalendar(year);
    const calendar = calendarSnap.exists ?
      Object.assign({}, fallback, calendarSnap.data() || {}, {isFallback: false}) :
      fallback;
    const overrideSnap = await bookingDb.collection('bookingHolidayOverrides')
      .where('date', '>=', `${year}-01-01`)
      .where('date', '<=', `${year}-12-31`)
      .get();
    return {
      calendar,
      overrides: overrideSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      })),
    };
  },
);

exports.setBookingHolidayOverride = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const identity = await getAuthenticatedMember(request);
    const actorUid = identity.memberUid;
    const actor = identity.member;
    if (actor.role !== 'owner') {
      throw new HttpsError('permission-denied', '僅 Owner 可調整特殊假日');
    }
    const date = cleanString(request.data && request.data.date, 10);
    const mode = cleanString(request.data && request.data.mode, 20);
    const reason = cleanString(request.data && request.data.reason, 200);
    if (!bookingCalendarDateParts(date) ||
        !['holiday', 'weekday', 'inactive'].includes(mode)) {
      throw new HttpsError('invalid-argument', '特殊假日設定格式不正確');
    }
    const ref = bookingHolidayOverrideRef(date);
    if (mode === 'inactive') {
      await ref.set({
        date,
        active: false,
        updatedAt: SERVER_TS(),
        updatedByUid: actorUid,
        updatedByName: memberDisplayName(actor, actorUid),
      }, {merge: true});
    } else {
      if (!reason) throw new HttpsError('invalid-argument', '請填寫調整原因');
      await ref.set({
        date,
        mode,
        active: true,
        reason,
        updatedAt: SERVER_TS(),
        updatedByUid: actorUid,
        updatedByName: memberDisplayName(actor, actorUid),
      }, {merge: true});
    }
    return {ok: true};
  },
);

exports.syncBookingHolidayCalendar = onCall(
  {region: 'asia-east1', timeoutSeconds: 60},
  async (request) => {
    const identity = await getAuthenticatedMember(request);
    const actorUid = identity.memberUid;
    if (identity.member.role !== 'owner') {
      throw new HttpsError('permission-denied', '僅 Owner 可同步假日資料');
    }
    const year = Number(request.data && request.data.year);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      throw new HttpsError('invalid-argument', '年度格式不正確');
    }
    const results = await runBookingHolidaySync(
      [year], actorUid, 'owner_manual',
    );
    if (!results[0].ok) {
      throw new HttpsError(
        'unavailable', '官方假日資料同步失敗，系統將繼續使用上次成功資料。',
      );
    }
    return results[0];
  },
);

exports.syncBookingHolidayCalendars = onSchedule(
  {schedule: '15 3 1 1 *', timeZone: 'Asia/Taipei', timeoutSeconds: 120},
  async () => {
    const year = currentTaipeiYear();
    await runBookingHolidaySync([year, year + 1], '', 'annual_confirm');
  },
);

exports.prefetchNextBookingHolidayCalendar = onSchedule(
  {schedule: '15 3 1 7-12 *', timeZone: 'Asia/Taipei', timeoutSeconds: 120},
  async () => {
    const nextYear = currentTaipeiYear() + 1;
    await runBookingHolidaySync([nextYear], '', 'annual_prefetch');
  },
);

exports.createBooking = onCall({region: 'asia-east1'}, async (request) => {
  const identity = await getAuthenticatedMember(request);
  const actorUid = identity.memberUid;
  if (!isEligibleMember(identity.member)) {
    throw new HttpsError('permission-denied', '操作者目前不具有效會員資格');
  }
  const actor = identity.member;
  const actorRole = actor.role || '';

  const input = (request.data || {}).booking || {};
  const date = cleanString(input.date, 10);
  const startTime = cleanString(input.startTime, 5);
  const endTime = cleanString(input.endTime, 5);
  const court = cleanString(input.court, 20);
  const mode = normaliseBookingMode(cleanString(input.mode, 30));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timeToMinutes(startTime)) ||
      !Number.isFinite(timeToMinutes(endTime)) ||
      timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    throw new HttpsError('invalid-argument', '預約日期或時間格式不正確');
  }
  if (mode === 'general' &&
      timeToMinutes(endTime) - timeToMinutes(startTime) > 60) {
    throw new HttpsError(
      'failed-precondition',
      '一般會員預約每次以 1 小時為限。',
    );
  }
  if (!['hard_a', 'hard_b', 'clay_a', 'clay_b'].includes(court)) {
    throw new HttpsError('invalid-argument', '場地資料不正確');
  }
  await assertBookingWithinOpenHours(date, startTime, endTime);
  if ((court === 'clay_a' || court === 'clay_b') &&
      !ADMIN_ROLES.has(actorRole)) {
    throw new HttpsError('permission-denied', '紅土場地僅限管理員預約');
  }
  if ((mode === 'groupClass' || mode === 'event_lock') &&
      !ADMIN_ROLES.has(actorRole)) {
    throw new HttpsError('permission-denied', '此預約模式僅限管理員建立');
  }
  if (mode === 'teaching' && actorRole !== 'coach' &&
      !ADMIN_ROLES.has(actorRole)) {
    throw new HttpsError('permission-denied', '教學預約僅限教練或管理員建立');
  }
  await assertMemberHasBookingAccess(actorUid, actor, date);

  const booking = {
    date,
    startTime,
    endTime,
    court,
    mode,
    createdBy: actorUid,
    createdByName: cleanString(input.createdByName, 100),
    primaryName: cleanString(input.primaryName, 100),
    status: 'active',
    createdAt: SERVER_TS(),
    updatedAt: SERVER_TS(),
  };
  if (Array.isArray(input.players)) {
    booking.players = input.players
      .filter((uid) => typeof uid === 'string' && uid)
      .slice(0, 20);
  }
  if (Array.isArray(input.guests)) {
    booking.guests = input.guests
      .map((name) => cleanString(name, 50))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (Array.isArray(input.students)) {
    booking.students = input.students
      .filter((uid) => typeof uid === 'string' && uid)
      .slice(0, 100);
  }
  booking.capacity = Number(input.capacity) || 0;
  booking.participantCount = Number(input.participantCount) || 0;
  if (input.coachId) booking.coachId = cleanString(input.coachId, 128);
  if (input.coachName) booking.coachName = cleanString(input.coachName, 100);
  if (input.title) booking.title = cleanString(input.title, 100);
  if (input.note) booking.note = cleanString(input.note, 300);
  if (mode === 'teaching' && actorRole === 'coach') {
    booking.coachId = actorUid;
  }
  if (mode === 'teaching' && !booking.coachId) {
    throw new HttpsError('invalid-argument', '請選擇教練');
  }
  if (mode === 'teaching') {
    await assertSelectedTeachingStudentsEligible(booking.students || [], date);
  }
  if (mode === 'general' &&
      (!booking.players || booking.players.length === 0 ||
       booking.players.length + (booking.guests || []).length > 4)) {
    throw new HttpsError('failed-precondition', '一般預約最多 4 人');
  }

  const bookingPlayerUids = Array.isArray(booking.players) ?
    [...new Set(booking.players.filter(Boolean))] : [];
  if (mode === 'general' || mode === 'pickleball') {
    await assertMembersHaveBookingAccess(bookingPlayerUids, date);
  }
  const actorName = memberDisplayName(actor, actorUid);
  const bookingAccessUids = [actorUid, ...bookingPlayerUids];
  const bookingSubject = bookingSubjectUid(booking);
  if (bookingSubject) bookingAccessUids.push(bookingSubject);
  if (mode === 'teaching') bookingAccessUids.push(...(booking.students || []));
  await Promise.all(bookingPlayerUids.map((uid) =>
    normaliseExpiredViolationCycle(
      uid, actorUid, actorName, 'createBooking',
    )));
  await assertPlayersNotSuspendedAndAudit(
    bookingPlayerUids, 'suspended_booking_rejected',
    actorUid, actorName, '', 'createBooking',
  );

  const subjectUid = bookingSubjectUid(booking);
  if (subjectUid) {
    const subjectSnap = await bookingDb.collection('members').doc(subjectUid).get();
    if (!subjectSnap.exists) {
      throw new HttpsError('failed-precondition', '找不到預約會員資料');
    }
    const subject = subjectSnap.data() || {};
    if (!isEligibleMember(subject)) {
      throw new HttpsError('failed-precondition', '此會員已離會或不具有效會員資格，無法預約');
    }
    const subjectRole = subject.role || '';
    if (!ADMIN_ROLES.has(subjectRole)) {
      const expiry = await membershipExpiryForBooking(
        subjectUid, subject, date,
      );
      if (!expiry) {
        throw new HttpsError(
          'failed-precondition',
          '找不到預約會員的會籍有效期限，請聯絡管理員確認。',
        );
      }
      if (date > expiry) {
        throw new HttpsError(
          'failed-precondition',
          `您的會籍有效期限至 ${expiry.replace(/-/g, '/')}，續費後方可預約此日期。`,
        );
      }

    }
    if (court === 'hard_a' || court === 'hard_b') {
      const sameDateSnap = await bookingDb.collection('bookings')
        .where('date', '==', date)
        .get();
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      await assertGeneralDailyLimitAllowed(
        sameDateBookings, booking, '',
      );
      if (subjectRole !== 'coach') {
        assertHardCourtUsageAllowed(
          sameDateBookings, subjectUid, startTime, endTime, '',
        );
      }
    }
  }

  const bookingRef = bookingDb.collection('bookings').doc();
  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(date));
  try {
    await bookingDb.runTransaction(async (transaction) => {
      await transaction.get(lockRef);
      await assertBookingWithinOpenHours(
        date, startTime, endTime, transaction,
      );
      const sameDateSnap = await transaction.get(
        bookingDb.collection('bookings').where('date', '==', date),
      );
      await assertPlayersNotSuspendedInTransaction(
        transaction, bookingPlayerUids, 'suspended_booking_rejected',
      );
      await assertMembersHaveBookingAccessInTransaction(
        transaction, bookingAccessUids, date,
      );
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      if (findCourtConflict(sameDateBookings, booking, '')) {
        throw new HttpsError(
          'already-exists',
          '此場地該時段已有預約，請選擇其他時段。',
        );
      }
      if (!shouldBypassParticipantConflict(actorRole, mode) &&
          findParticipantConflictUid(sameDateBookings, booking, '')) {
        throw new HttpsError(
          'failed-precondition',
          '此會員已在同時段參與其他預約。',
        );
      }
      const exceededUid = findGeneralDailyLimitExceededUid(
        sameDateBookings, booking, '',
      );
      if (exceededUid) {
        throw new HttpsError('failed-precondition', GENERAL_DAILY_LIMIT_MESSAGE);
      }
      transaction.set(lockRef, {
        updatedAt: SERVER_TS(),
        version: admin.firestore.FieldValue.increment(1),
      }, {merge: true});
      transaction.set(bookingRef, booking);
    });
  } catch (error) {
    await recordSuspensionRejection(
      error, actorUid, actorName, bookingRef.id, 'createBooking',
    );
    throw error;
  }
  return {ok: true, bookingId: bookingRef.id};
});

exports.updateBooking = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  if (!isActiveBooking(context.booking)) {
    throw new HttpsError('failed-precondition', '此預約已取消或作廢');
  }
  if (context.booking.extensionStatus === 'approved') {
    throw new HttpsError(
      'failed-precondition',
      '已核准的加時預約不可修改日期、時間、場地或參與者。',
    );
  }
  const originalStartMs = bookingStartMs(context.booking);
  if (!Number.isFinite(originalStartMs) || Date.now() >= originalStartMs) {
    throw new HttpsError('failed-precondition', '預約已開始，無法修改');
  }
  if (!ADMIN_ROLES.has(context.actorRole) &&
      originalStartMs - Date.now() < 30 * 60 * 1000) {
    throw new HttpsError(
      'failed-precondition',
      '預約開始前 30 分鐘內無法自行修改，請聯絡管理員。',
    );
  }
  const input = (request.data || {}).booking || {};
  const date = cleanString(input.date, 10);
  const startTime = cleanString(input.startTime, 5);
  const endTime = cleanString(input.endTime, 5);
  const court = cleanString(input.court, 20);
  const mode = normaliseBookingMode(cleanString(input.mode, 30));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timeToMinutes(startTime)) ||
      !Number.isFinite(timeToMinutes(endTime)) ||
      timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    throw new HttpsError('invalid-argument', '預約日期或時間格式不正確');
  }
  if (mode === 'general' &&
      timeToMinutes(endTime) - timeToMinutes(startTime) > 60) {
    throw new HttpsError(
      'failed-precondition',
      '一般會員預約每次以 1 小時為限。',
    );
  }
  if (!['hard_a', 'hard_b', 'clay_a', 'clay_b'].includes(court)) {
    throw new HttpsError('invalid-argument', '場地資料不正確');
  }
  await assertBookingWithinOpenHours(date, startTime, endTime);
  if ((court === 'clay_a' || court === 'clay_b') &&
      !ADMIN_ROLES.has(context.actorRole)) {
    throw new HttpsError('permission-denied', '紅土場地僅限管理員預約');
  }
  if ((mode === 'groupClass' || mode === 'event_lock') &&
      !ADMIN_ROLES.has(context.actorRole)) {
    throw new HttpsError('permission-denied', '此預約模式僅限管理員建立');
  }
  if (mode === 'teaching' && context.actorRole !== 'coach' &&
      !ADMIN_ROLES.has(context.actorRole)) {
    throw new HttpsError('permission-denied', '教學預約僅限教練或管理員建立');
  }
  await assertMemberHasBookingAccess(
    context.actorUid, context.actor, date,
  );

  const update = {
    date,
    startTime,
    endTime,
    court,
    mode,
    note: cleanString(input.note, 300),
    updatedAt: SERVER_TS(),
    updatedBy: context.actorUid,
    updatedByName: context.actor.realName ||
      context.actor.displayName || '',
  };
  if (mode === 'teaching') {
    update.coachId = context.actorRole === 'coach' ? context.actorUid :
      cleanString(input.coachId, 128);
    if (!update.coachId) {
      throw new HttpsError('invalid-argument', '請選擇教練');
    }
    update.coachName = cleanString(input.coachName, 100);
    update.students = Array.isArray(input.students) ?
      input.students.filter((uid) => typeof uid === 'string' && uid)
        .slice(0, 100) : [];
  } else if (mode === 'groupClass') {
    update.coachId = cleanString(input.coachId, 128);
    update.coachName = cleanString(input.coachName, 100);
    update.students = Array.isArray(input.students) ?
      input.students.filter((uid) => typeof uid === 'string' && uid)
        .slice(0, 100) : [];
    update.title = cleanString(input.title, 100);
  } else if (mode === 'event_lock') {
    update.title = cleanString(input.title, 100) || '其他';
  }

  const booking = Object.assign({}, context.booking, update);
  if (mode === 'teaching') {
    await assertSelectedTeachingStudentsEligible(booking.students || [], date);
  }
  const bookingPlayerUids = Array.isArray(booking.players) ?
    [...new Set(booking.players.filter(Boolean))] : [];
  if (mode === 'general' || mode === 'pickleball') {
    await assertMembersHaveBookingAccess(bookingPlayerUids, date);
  }
  const actorName = memberDisplayName(context.actor, context.actorUid);
  const bookingAccessUids = [context.actorUid, ...bookingPlayerUids];
  const bookingSubject = bookingSubjectUid(booking);
  if (bookingSubject) bookingAccessUids.push(bookingSubject);
  if (mode === 'teaching') bookingAccessUids.push(...(booking.students || []));
  await Promise.all(bookingPlayerUids.map((uid) =>
    normaliseExpiredViolationCycle(
      uid, context.actorUid, actorName, 'updateBooking',
    )));
  await assertPlayersNotSuspendedAndAudit(
    bookingPlayerUids, 'suspended_booking_rejected',
    context.actorUid, actorName, context.bookingId, 'updateBooking',
  );
  const subjectUid = bookingSubjectUid(booking);
  if (subjectUid) {
    const subjectSnap = await bookingDb.collection('members').doc(subjectUid).get();
    if (!subjectSnap.exists) {
      throw new HttpsError('failed-precondition', '找不到預約會員資料');
    }
    const subject = subjectSnap.data() || {};
    if (!isEligibleMember(subject)) {
      throw new HttpsError('failed-precondition', '此會員已離會或不具有效會員資格，無法預約');
    }
    const subjectRole = subject.role || '';
    if (!ADMIN_ROLES.has(subjectRole)) {
      const expiry = await membershipExpiryForBooking(
        subjectUid, subject, date,
      );
      if (!expiry) {
        throw new HttpsError(
          'failed-precondition',
          '找不到預約會員的會籍有效期限，請聯絡管理員確認。',
        );
      }
      if (date > expiry) {
        throw new HttpsError(
          'failed-precondition',
          `您的會籍有效期限至 ${expiry.replace(/-/g, '/')}，續費後方可預約此日期。`,
        );
      }
    }
    if (court === 'hard_a' || court === 'hard_b') {
      const sameDateSnap = await bookingDb.collection('bookings')
        .where('date', '==', date)
        .get();
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      await assertGeneralDailyLimitAllowed(
        sameDateBookings, booking, context.bookingId,
      );
      if (subjectRole !== 'coach') {
        assertHardCourtUsageAllowed(
          sameDateBookings,
          subjectUid,
          startTime,
          endTime,
          context.bookingId,
        );
      }
    }
  }

  const mutationDates = [...new Set([context.booking.date, date])].sort();
  const updateLockRefs = mutationDates.map((mutationDate) =>
    bookingDb.collection('bookingMutationLocks')
      .doc(bookingDateLockId(mutationDate)));
  try {
    await bookingDb.runTransaction(async (transaction) => {
    const currentBookingSnap = await transaction.get(context.bookingRef);
    for (const lockRef of updateLockRefs) await transaction.get(lockRef);
    await assertBookingWithinOpenHours(
      date, startTime, endTime, transaction,
    );
    const newDateSnap = await transaction.get(
      bookingDb.collection('bookings').where('date', '==', date),
    );
    const oldDateSnap = context.booking.date === date ? newDateSnap :
      await transaction.get(bookingDb.collection('bookings')
        .where('date', '==', context.booking.date));
    await assertPlayersNotSuspendedInTransaction(
      transaction, bookingPlayerUids, 'suspended_booking_rejected',
    );
    await assertMembersHaveBookingAccessInTransaction(
      transaction, bookingAccessUids, date,
    );
    if (!currentBookingSnap.exists ||
        !isActiveBooking(currentBookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const sameDateBookings = newDateSnap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() || {}),
    }));
    if (findCourtConflict(sameDateBookings, booking, context.bookingId)) {
      throw new HttpsError(
        'already-exists',
        '此場地該時段已有預約，請選擇其他時段。',
      );
    }
    if (!shouldBypassParticipantConflict(context.actorRole, mode) &&
        findParticipantConflictUid(
      sameDateBookings, booking, context.bookingId,
    )) {
      throw new HttpsError(
        'failed-precondition',
        '此會員已在同時段參與其他預約。',
      );
    }
    const exceededUid = findGeneralDailyLimitExceededUid(
      sameDateBookings, booking, context.bookingId,
    );
    if (exceededUid) {
      throw new HttpsError('failed-precondition', GENERAL_DAILY_LIMIT_MESSAGE);
    }
    const currentBooking = Object.assign(
      {id: context.bookingId}, currentBookingSnap.data() || {},
    );
    if (currentBooking.date !== context.booking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    const bookingAfter = context.booking.date === date ?
      Object.assign({}, currentBooking, update) : null;
    await revokeInvalidExtensions(
      transaction, oldDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      })), currentBooking, bookingAfter, context.actorUid,
      context.actor.realName || context.actor.displayName || '',
      '原一般預約日期或時段已變更',
    );
    updateLockRefs.forEach((lockRef) => transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true}));
    transaction.update(context.bookingRef, update);
    });
  } catch (error) {
    await recordSuspensionRejection(
      error, context.actorUid, actorName, context.bookingId, 'updateBooking',
    );
    throw error;
  }
  return {ok: true};
});

function assertParticipantMutationAllowed(booking) {
  if (!isActiveBooking(booking)) {
    throw new HttpsError('failed-precondition', '此預約已取消或作廢');
  }
  const startMs = bookingStartMs(booking);
  if (!Number.isFinite(startMs) || Date.now() >= startMs) {
    throw new HttpsError('failed-precondition', '預約已開始，無法修改參與者');
  }
  const mode = booking.mode || 'general';
  if (mode !== 'general' && mode !== 'normal') {
    throw new HttpsError('failed-precondition', '此預約模式不支援一般參與者管理');
  }
  if (booking.extensionStatus === 'approved') {
    throw new HttpsError(
      'failed-precondition',
      '加時預約僅限申請會員本人使用，不可新增或移除參與者。',
    );
  }
}

async function assertNoParticipantTimeConflict(context, targetUid) {
  const targetStart = bookingStartMs(context.booking);
  const endBooking = Object.assign({}, context.booking, {
    startTime: context.booking.endTime,
  });
  const targetEnd = bookingStartMs(endBooking);
  if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd)) {
    throw new HttpsError('failed-precondition', '預約時間資料不完整');
  }

  const sameDateSnap = await bookingDb.collection('bookings')
    .where('date', '==', context.booking.date)
    .get();
  const hasConflict = sameDateSnap.docs.some((doc) => {
    if (doc.id === context.bookingId) return false;
    const booking = doc.data() || {};
    if (!isActiveBooking(booking)) return false;
    const start = bookingStartMs(booking);
    const endBooking = Object.assign({}, booking, {
      startTime: booking.endTime,
    });
    const end = bookingStartMs(endBooking);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (!(targetStart < end && targetEnd > start)) return false;
    return booking.coachId === targetUid ||
      (Array.isArray(booking.players) && booking.players.includes(targetUid)) ||
      (Array.isArray(booking.students) && booking.students.includes(targetUid));
  });
  if (hasConflict) {
    throw new HttpsError(
      'failed-precondition',
      '此會員已在同時段參與其他預約',
    );
  }
}

function addAuditWrite(batch, context, action, targetUid, reason, targetLabel) {
  const auditRef = bookingDb.collection('bookingAuditLogs').doc();
  const audit = {
    actorUid: context.actorUid,
    targetUid: targetUid || '',
    bookingId: context.bookingId,
    action,
    createdAt: SERVER_TS(),
    reason: reason || '',
    source: 'web_callable',
  };
  if (targetLabel) audit.targetLabel = targetLabel;
  batch.set(auditRef, audit);
}

function addMembershipExpiryCancelNotification(batch, context) {
  const targetUid = bookingSubjectUid(context.booking);
  if (!targetUid) return;
  const courtLabel = {
    hard_a: 'Hard A',
    hard_b: 'Hard B',
    clay_a: 'Clay A',
    clay_b: 'Clay B',
  }[context.booking.court] || context.booking.court || '';
  const notificationRef = bookingDb.collection('notifications')
    .doc(`membership_expiry_cancel_${context.bookingId}`);
  batch.set(notificationRef, {
    uid: targetUid,
    type: 'booking_cancelled',
    action: 'cancel',
    bookingId: context.bookingId,
    title: '預約已取消',
    date: context.booking.date || '',
    startTime: context.booking.startTime || '',
    endTime: context.booking.endTime || '',
    court: context.booking.court || '',
    courtLabel,
    cancelledByName: context.actor.realName ||
      context.actor.displayName || '',
    cancelledByUid: context.actorUid,
    cancelReason: MEMBERSHIP_EXPIRY_CANCEL_REASON,
    hint: '完成續費後即可重新預約。',
    message: '預約已取消。' + MEMBERSHIP_EXPIRY_CANCEL_REASON +
      '完成續費後即可重新預約。',
    createdAt: SERVER_TS(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ),
    read: false,
  });
}

function extensionAuditData(
  requestId, bookingId, actorUid, actorName, targetUid, action, reason, details,
) {
  const audit = {
    requestId,
    bookingId: bookingId || '',
    actorUid,
    actorName: actorName || '',
    targetUid,
    action,
    reason: reason || '',
    createdAt: SERVER_TS(),
    source: 'web_callable',
  };
  if (details) {
    audit.date = details.date || '';
    audit.court = details.court || '';
    audit.startTime = details.startTime || '';
    audit.endTime = details.endTime || '';
    audit.attempt = Number(details.attempt) || 1;
  }
  return audit;
}

function extensionNotificationData(
  extensionRequest, type, bookingId, actorUid, actorName, reason,
) {
  const approved = type === 'booking_extension_approved';
  const title = approved ? '加時申請已核准' : '加時申請未通過';
  const message = approved ?
    '您的加時申請已核准，預約已建立。' :
    `您的加時申請未通過。${reason ? `原因：${reason}` : ''}`;
  return {
    uid: extensionRequest.requesterUid,
    type,
    action: approved ? 'approve' : 'reject',
    requestId: extensionRequest.id,
    bookingId: bookingId || '',
    title,
    date: extensionRequest.date,
    startTime: extensionRequest.startTime,
    endTime: extensionRequest.endTime,
    court: extensionRequest.court,
    courtLabel: courtLabel(extensionRequest.court),
    actedByUid: actorUid,
    actedByName: actorName,
    reason: reason || '',
    message,
    createdAt: SERVER_TS(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ),
    read: false,
  };
}

function extensionRevokedNotificationData(
  extensionBooking, requestId, actorUid, actorName, reason,
) {
  return {
    uid: generalBookingPlayerUids(extensionBooking)[0] || '',
    type: 'booking_extension_revoked',
    action: 'revoke',
    requestId,
    bookingId: extensionBooking.id,
    title: '加時預約已撤銷',
    date: extensionBooking.date || '',
    startTime: extensionBooking.startTime || '',
    endTime: extensionBooking.endTime || '',
    court: extensionBooking.court || '',
    courtLabel: courtLabel(extensionBooking.court),
    actedByUid: actorUid,
    actedByName: actorName,
    reason,
    message: `原一般預約時數已不足 2 小時，加時預約已撤銷。${reason}`,
    createdAt: SERVER_TS(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ),
    read: false,
  };
}

async function revokeInvalidExtensions(
  transaction, sameDateBookings, changedBooking, changedBookingAfter,
  actorUid, actorName, reason,
) {
  const affectedUids = generalBookingPlayerUids(changedBooking);
  const bookingsAfterMutation = sameDateBookings.map((booking) =>
    booking.id === changedBooking.id ?
      (changedBookingAfter || Object.assign({}, booking, {status: 'cancelled'})) :
      booking);
  const extensionBookings = [];

  if (changedBooking.extensionStatus === 'approved') {
    extensionBookings.push(changedBooking);
  } else {
    affectedUids.forEach((uid) => {
      if (normalGeneralMinutesForUid(bookingsAfterMutation, uid) >= 120) return;
      bookingsAfterMutation.forEach((booking) => {
        if (isActiveBooking(booking) &&
            booking.extensionStatus === 'approved' &&
            generalBookingPlayerUids(booking).includes(uid)) {
          extensionBookings.push(booking);
        }
      });
    });
  }

  const uniqueExtensions = [...new Map(extensionBookings.map((booking) =>
    [booking.id, booking])).values()];
  const requestSnapshots = new Map();
  for (const extensionBooking of uniqueExtensions) {
    const requestId = cleanString(extensionBooking.extensionRequestId, 600);
    if (!requestId || requestSnapshots.has(requestId)) continue;
    requestSnapshots.set(requestId, await transaction.get(
      bookingDb.collection('bookingExtensionRequests').doc(requestId),
    ));
  }

  uniqueExtensions.forEach((extensionBooking) => {
    const requestId = cleanString(extensionBooking.extensionRequestId, 600);
    const revokeReason = reason || '原一般預約時數已不足 2 小時';
    if (extensionBooking.id !== changedBooking.id) {
      transaction.update(
        bookingDb.collection('bookings').doc(extensionBooking.id),
        {
          status: 'cancelled',
          cancelReason: revokeReason,
          cancelledBy: actorUid,
          cancelledByUid: actorUid,
          cancelledByName: actorName,
          cancelledAt: SERVER_TS(),
          extensionRevokedAt: SERVER_TS(),
          updatedAt: SERVER_TS(),
        },
      );
    }
    const requestSnap = requestSnapshots.get(requestId);
    if (requestId && requestSnap && requestSnap.exists) {
      transaction.update(requestSnap.ref, {
        status: 'revoked',
        revokedByUid: actorUid,
        revokedByName: actorName,
        revokedAt: SERVER_TS(),
        revokeReason,
        updatedAt: SERVER_TS(),
      });
    }
    transaction.set(
      bookingDb.collection('bookingExtensionAuditLogs').doc(),
      extensionAuditData(
        requestId, extensionBooking.id, actorUid, actorName,
        generalBookingPlayerUids(extensionBooking)[0] || '',
        'extension_revoked', revokeReason, extensionBooking,
      ),
    );
    if (requestId) {
      transaction.set(
        bookingDb.collection('notifications')
          .doc(`booking_extension_revoked_${requestId}`),
        extensionRevokedNotificationData(
          extensionBooking, requestId, actorUid, actorName, revokeReason,
        ),
      );
    }
  });
  return uniqueExtensions.map((booking) => booking.id);
}

// ── Phase 1A: booking participant authorization + minimal audit ──────
exports.addBookingParticipant = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  await assertMemberHasBookingAccess(
    context.actorUid, context.actor, context.booking.date,
  );
  const data = request.data || {};
  const targetUid = cleanString(data.targetUid, 128);
  const guestName = cleanString(data.guestName, 50);
  const reason = cleanString(data.reason, 300);
  if ((!targetUid && !guestName) || (targetUid && guestName)) {
    throw new HttpsError('invalid-argument', '請指定一位會員或一位來賓');
  }

  assertParticipantMutationAllowed(context.booking);
  const players = Array.isArray(context.booking.players) ?
    context.booking.players.slice() : [];
  const guests = Array.isArray(context.booking.guests) ?
    context.booking.guests.slice() : [];
  const capacity = Number(context.booking.capacity) || 4;
  if (players.length + guests.length >= capacity) {
    throw new HttpsError('failed-precondition', '此預約已達人數上限');
  }

  const update = {updatedAt: SERVER_TS()};
  let auditTargetUid = '';
  let auditTargetLabel = '';
  const actorName = memberDisplayName(context.actor, context.actorUid);
  if (targetUid) {
    if (players.includes(targetUid)) {
      throw new HttpsError('already-exists', '此會員已在預約中');
    }
    const targetSnap = await bookingDb.collection('members').doc(targetUid).get();
    if (!targetSnap.exists) {
      throw new HttpsError('not-found', '找不到指定會員');
    }
    const targetMember = targetSnap.data() || {};
    if (!isEligibleMember(targetMember)) {
      throw new HttpsError('failed-precondition', '此會員目前不具有效資格');
    }
    await assertMemberHasBookingAccess(
      targetUid, targetMember, context.booking.date,
    );
    await normaliseExpiredViolationCycle(
      targetUid, context.actorUid, actorName, 'addBookingParticipant',
    );
    await assertPlayersNotSuspendedAndAudit(
      [targetUid], 'suspended_player_add_rejected',
      context.actorUid, actorName, context.bookingId,
      'addBookingParticipant',
    );
    await assertNoParticipantTimeConflict(context, targetUid);
    const bookingWithParticipant = Object.assign({}, context.booking, {
      players: players.concat([targetUid]),
    });
    if (normaliseBookingMode(bookingWithParticipant.mode) === 'general' &&
        (bookingWithParticipant.court === 'hard_a' ||
         bookingWithParticipant.court === 'hard_b')) {
      const sameDateSnap = await bookingDb.collection('bookings')
        .where('date', '==', bookingWithParticipant.date)
        .get();
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      await assertGeneralDailyLimitAllowed(
        sameDateBookings, bookingWithParticipant, context.bookingId,
      );
    }
    update.players = admin.firestore.FieldValue.arrayUnion(targetUid);
    auditTargetUid = targetUid;
  } else {
    update.guests = guests.concat([guestName]);
    auditTargetLabel = guestName;
  }

  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(context.booking.date));
  try {
    await bookingDb.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(context.bookingRef);
    await transaction.get(lockRef);
    const sameDateSnap = await transaction.get(
      bookingDb.collection('bookings')
        .where('date', '==', context.booking.date),
    );
    if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const currentBooking = Object.assign(
      {id: context.bookingId}, bookingSnap.data() || {},
    );
    if (currentBooking.date !== context.booking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    assertParticipantMutationAllowed(currentBooking);
    const currentPlayers = generalBookingPlayerUids(currentBooking);
    const currentGuests = Array.isArray(currentBooking.guests) ?
      currentBooking.guests : [];
    if (currentPlayers.length + currentGuests.length >=
        (Number(currentBooking.capacity) || 4)) {
      throw new HttpsError('failed-precondition', '此預約已達人數上限');
    }
    if (targetUid) {
      await assertPlayersNotSuspendedInTransaction(
        transaction, [targetUid], 'suspended_player_add_rejected',
      );
      await assertMembersHaveBookingAccessInTransaction(
        transaction, [context.actorUid, targetUid], currentBooking.date,
      );
      if (currentPlayers.includes(targetUid)) {
        throw new HttpsError('already-exists', '此會員已在預約中');
      }
      const bookingAfter = Object.assign({}, currentBooking, {
        players: currentPlayers.concat([targetUid]),
      });
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      if (findParticipantConflictUid(
        sameDateBookings, bookingAfter, context.bookingId,
      )) {
        throw new HttpsError(
          'failed-precondition', '此會員已在同時段參與其他預約',
        );
      }
      const exceededUid = findGeneralDailyLimitExceededUid(
        sameDateBookings, bookingAfter, context.bookingId,
      );
      if (exceededUid) {
        throw new HttpsError('failed-precondition', GENERAL_DAILY_LIMIT_MESSAGE);
      }
    }
    transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true});
    transaction.update(context.bookingRef, update);
    addAuditWrite(
      transaction, Object.assign({}, context, {booking: currentBooking}),
      'participant_added', auditTargetUid, reason, auditTargetLabel,
    );
    });
  } catch (error) {
    await recordSuspensionRejection(
      error, context.actorUid, actorName,
      context.bookingId, 'addBookingParticipant',
    );
    throw error;
  }
  return {ok: true};
});

exports.removeBookingParticipant = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  const data = request.data || {};
  const targetUid = cleanString(data.targetUid, 128);
  const guestIndex = Number.isInteger(data.guestIndex) ? data.guestIndex : null;
  const reason = cleanString(data.reason, 300);
  if ((!targetUid && guestIndex === null) || (targetUid && guestIndex !== null)) {
    throw new HttpsError('invalid-argument', '請指定一位會員或一位來賓');
  }

  assertParticipantMutationAllowed(context.booking);
  const players = Array.isArray(context.booking.players) ?
    context.booking.players.slice() : [];
  const guests = Array.isArray(context.booking.guests) ?
    context.booking.guests.slice() : [];

  const update = {updatedAt: SERVER_TS()};
  let auditTargetUid = '';
  let auditTargetLabel = '';
  if (targetUid) {
    if (targetUid === context.booking.createdBy) {
      throw new HttpsError('failed-precondition', '不可移除預約建立者');
    }
    if (!players.includes(targetUid)) {
      throw new HttpsError('not-found', '此會員不在預約中');
    }
    update.players = admin.firestore.FieldValue.arrayRemove(targetUid);
    auditTargetUid = targetUid;
  } else {
    if (guestIndex < 0 || guestIndex >= guests.length) {
      throw new HttpsError('not-found', '找不到此來賓');
    }
    auditTargetLabel = guests[guestIndex];
    guests.splice(guestIndex, 1);
    update.guests = guests;
  }

  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(context.booking.date));
  let revokedExtensionBookingIds = [];
  await bookingDb.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(context.bookingRef);
    await transaction.get(lockRef);
    const sameDateSnap = await transaction.get(
      bookingDb.collection('bookings')
        .where('date', '==', context.booking.date),
    );
    if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const currentBooking = Object.assign(
      {id: context.bookingId}, bookingSnap.data() || {},
    );
    if (currentBooking.date !== context.booking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    const currentPlayers = generalBookingPlayerUids(currentBooking);
    if (targetUid && !currentPlayers.includes(targetUid)) {
      throw new HttpsError('not-found', '此會員不在預約中');
    }
    if (targetUid) {
      const bookingAfter = Object.assign({}, currentBooking, {
        players: currentPlayers.filter((uid) => uid !== targetUid),
      });
      revokedExtensionBookingIds = await revokeInvalidExtensions(
        transaction, sameDateSnap.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() || {}),
        })), currentBooking, bookingAfter,
        context.actorUid,
        context.actor.realName || context.actor.displayName || '',
        reason || '已從原一般預約移除',
      );
    }
    transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true});
    transaction.update(context.bookingRef, update);
    addAuditWrite(
      transaction, Object.assign({}, context, {booking: currentBooking}),
      'participant_removed', auditTargetUid, reason, auditTargetLabel,
    );
  });
  return {ok: true, revokedExtensionBookingIds};
});

exports.leaveBooking = onCall({region: 'asia-east1'}, async (request) => {
  const identity = await getAuthenticatedMember(request);
  const actorUid = identity.memberUid;
  const bookingId = cleanString((request.data || {}).bookingId, 128);
  if (!bookingId) {
    throw new HttpsError('invalid-argument', 'bookingId 必填');
  }
  const bookingRef = bookingDb.collection('bookings').doc(bookingId);
  const initialSnap = await bookingRef.get();
  if (!initialSnap.exists) throw new HttpsError('not-found', '找不到此預約');
  const initialBooking = initialSnap.data() || {};
  assertParticipantMutationAllowed(initialBooking);
  if (initialBooking.createdBy === actorUid) {
    throw new HttpsError('failed-precondition', '預約建立者不可退出自己的預約');
  }
  if (!generalBookingPlayerUids(initialBooking).includes(actorUid)) {
    throw new HttpsError('not-found', '您不在此預約中');
  }
  if (bookingStartMs(initialBooking) - Date.now() < 30 * 60 * 1000) {
    throw new HttpsError('failed-precondition', '距開始不足 30 分鐘，無法退出');
  }

  const actor = identity.member;
  const actorName = actor.realName || actor.displayName || '';
  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(initialBooking.date));
  let revokedExtensionBookingIds = [];
  await bookingDb.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(bookingRef);
    await transaction.get(lockRef);
    const sameDateSnap = await transaction.get(
      bookingDb.collection('bookings')
        .where('date', '==', initialBooking.date),
    );
    if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const booking = Object.assign({id: bookingId}, bookingSnap.data() || {});
    if (booking.date !== initialBooking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    assertParticipantMutationAllowed(booking);
    if (booking.createdBy === actorUid ||
        !generalBookingPlayerUids(booking).includes(actorUid)) {
      throw new HttpsError('failed-precondition', '目前無法退出此預約');
    }
    const bookingAfter = Object.assign({}, booking, {
      players: generalBookingPlayerUids(booking)
        .filter((uid) => uid !== actorUid),
    });
    revokedExtensionBookingIds = await revokeInvalidExtensions(
      transaction, sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      })), booking, bookingAfter, actorUid, actorName,
      '已退出原一般預約',
    );
    transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true});
    transaction.update(bookingRef, {
      players: admin.firestore.FieldValue.arrayRemove(actorUid),
      participantCount: admin.firestore.FieldValue.increment(-1),
      updatedAt: SERVER_TS(),
    });
    addAuditWrite(
      transaction,
      {actorUid, bookingId, booking, actor, bookingRef},
      'participant_removed', actorUid, '會員自行退出', '',
    );
  });
  return {ok: true, revokedExtensionBookingIds};
});

exports.cancelBooking = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  const reason = cleanString((request.data || {}).reason, 300);
  if (ADMIN_ROLES.has(context.actorRole) && !reason) {
    throw new HttpsError('invalid-argument', '管理員取消預約必須填寫原因');
  }
  const startMs = bookingStartMs(context.booking);
  if (!Number.isFinite(startMs)) {
    throw new HttpsError('failed-precondition', '預約時間資料不完整');
  }
  const isOwner = context.actorRole === 'owner';
  if (Date.now() >= startMs && !isOwner) {
    throw new HttpsError('failed-precondition', '預約已開始，無法取消');
  }
  if (Date.now() < startMs && startMs - Date.now() < 30 * 60 * 1000) {
    throw new HttpsError('failed-precondition', '距開始不足 30 分鐘，無法取消');
  }

  const actorName = context.actor.realName ||
    context.actor.displayName || '';
  const update = {
    status: 'cancelled',
    cancelledBy: context.actorUid,
    cancelledByUid: context.actorUid,
    cancelledByName: actorName,
    cancelledAt: SERVER_TS(),
    updatedAt: SERVER_TS(),
  };
  if (reason) update.cancelReason = reason;

  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(context.booking.date));
  let revokedExtensionBookingIds = [];
  await bookingDb.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(context.bookingRef);
    await transaction.get(lockRef);
    const sameDateSnap = await transaction.get(
      bookingDb.collection('bookings')
        .where('date', '==', context.booking.date),
    );
    if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const booking = Object.assign(
      {id: context.bookingId}, bookingSnap.data() || {},
    );
    if (booking.date !== context.booking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    revokedExtensionBookingIds = await revokeInvalidExtensions(
      transaction, sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      })), booking, Object.assign({}, booking, {status: 'cancelled'}),
      context.actorUid, actorName,
      reason || '原一般預約已取消',
    );
    if (booking.extensionStatus === 'approved') {
      update.extensionRevokedAt = SERVER_TS();
    }
    transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true});
    transaction.update(context.bookingRef, update);
    const currentContext = Object.assign({}, context, {booking});
    addAuditWrite(
      transaction, currentContext, 'cancel', booking.createdBy || '', reason, '',
    );
    if (reason === MEMBERSHIP_EXPIRY_CANCEL_REASON) {
      addMembershipExpiryCancelNotification(transaction, currentContext);
    }
  });
  return {
    ok: true,
    cancelledByName: actorName,
    revokedExtensionBookingIds,
  };
});

exports.voidBooking = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  if (context.actorRole !== 'owner') {
    throw new HttpsError('permission-denied', '僅開發者可強制作廢');
  }
  const reason = cleanString((request.data || {}).reason, 300);
  const actorName = context.actor.realName || context.actor.displayName || '';
  const lockRef = bookingDb.collection('bookingMutationLocks')
    .doc(bookingDateLockId(context.booking.date));
  let revokedExtensionBookingIds = [];
  await bookingDb.runTransaction(async (transaction) => {
    const bookingSnap = await transaction.get(context.bookingRef);
    await transaction.get(lockRef);
    const sameDateSnap = await transaction.get(
      bookingDb.collection('bookings')
        .where('date', '==', context.booking.date),
    );
    if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此預約已取消或作廢');
    }
    const booking = Object.assign(
      {id: context.bookingId}, bookingSnap.data() || {},
    );
    if (booking.date !== context.booking.date) {
      throw new HttpsError('aborted', '預約日期已變更，請重新操作');
    }
    revokedExtensionBookingIds = await revokeInvalidExtensions(
      transaction, sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      })), booking, Object.assign({}, booking, {status: 'void'}),
      context.actorUid, actorName,
      reason || '原一般預約已作廢',
    );
    const update = {
      status: 'void',
      voidBy: context.actorUid,
      voidByName: actorName,
      voidAt: SERVER_TS(),
      updatedAt: SERVER_TS(),
    };
    if (reason) update.voidReason = reason;
    if (booking.extensionStatus === 'approved') {
      update.extensionRevokedAt = SERVER_TS();
    }
    transaction.set(lockRef, {
      updatedAt: SERVER_TS(),
      version: admin.firestore.FieldValue.increment(1),
    }, {merge: true});
    transaction.update(context.bookingRef, update);
    addAuditWrite(
      transaction, Object.assign({}, context, {booking}),
      'void', booking.createdBy || '', reason, '',
    );
  });
  return {ok: true, voidByName: actorName, revokedExtensionBookingIds};
});

exports.repairBookingOverlap = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const context = await getBookingActorContext(request);
    if (context.actorRole !== 'owner') {
      throw new HttpsError('permission-denied', '僅 Owner 可執行此操作');
    }
    const targetCourt = cleanString((request.data || {}).targetCourt, 20);
    const pairedCourt = {
      hard_a: 'hard_b',
      hard_b: 'hard_a',
      clay_a: 'clay_b',
      clay_b: 'clay_a',
    }[context.booking.court];
    if (!pairedCourt || targetCourt !== pairedCourt) {
      throw new HttpsError('invalid-argument', '修復目標場地不正確');
    }
    const actorName = context.actor.realName || context.actor.displayName || '';
    const lockRef = bookingDb.collection('bookingMutationLocks')
      .doc(bookingDateLockId(context.booking.date));
    await bookingDb.runTransaction(async (transaction) => {
      const bookingSnap = await transaction.get(context.bookingRef);
      await transaction.get(lockRef);
      const sameDateSnap = await transaction.get(
        bookingDb.collection('bookings')
          .where('date', '==', context.booking.date),
      );
      if (!bookingSnap.exists || !isActiveBooking(bookingSnap.data() || {})) {
        throw new HttpsError('failed-precondition', '此預約已取消或作廢');
      }
      const booking = Object.assign(
        {id: context.bookingId}, bookingSnap.data() || {},
      );
      if (booking.date !== context.booking.date ||
          booking.court !== context.booking.court) {
        throw new HttpsError('aborted', '預約場地已變更，請重新掃描');
      }
      const candidate = Object.assign({}, booking, {court: targetCourt});
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      if (findCourtConflict(sameDateBookings, candidate, context.bookingId)) {
        throw new HttpsError(
          'already-exists', '目標場地該時段已有預約，請重新掃描。',
        );
      }
      transaction.set(lockRef, {
        updatedAt: SERVER_TS(),
        version: admin.firestore.FieldValue.increment(1),
      }, {merge: true});
      transaction.update(context.bookingRef, {
        court: targetCourt,
        movedFromCourt: booking.court,
        movedReason: 'overlap_conflict_auto_fix',
        movedAt: SERVER_TS(),
        movedBy: context.actorUid,
        history: admin.firestore.FieldValue.arrayUnion({
          type: 'court_auto_moved',
          fromCourt: booking.court,
          toCourt: targetCourt,
          reason: 'overlap_conflict_auto_fix',
          createdAt: new Date(),
          createdBy: context.actorUid,
        }),
      });
      addAuditWrite(
        transaction, Object.assign({}, context, {booking}),
        'court_auto_moved', booking.createdBy || '',
        'overlap_conflict_auto_fix', targetCourt,
      );
    });
    return {ok: true};
  },
);

exports.submitBookingExtensionRequest = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const identity = await getAuthenticatedMember(request);
    const requesterUid = identity.memberUid;
    const member = identity.member;
    const requesterName = memberDisplayName(member, requesterUid);
    const input = request.data || {};
    const date = cleanString(input.date, 10);
    const court = cleanString(input.court, 20);
    const startTime = cleanString(input.startTime, 5);
    const endTime = cleanString(input.endTime, 5);
    assertExtensionTimeInput(date, court, startTime, endTime);
    await assertBookingWithinOpenHours(date, startTime, endTime);
    await assertExtensionMemberEligible(requesterUid, member, date);
    await normaliseExpiredViolationCycle(
      requesterUid, requesterUid, requesterName,
      'submitBookingExtensionRequest',
    );
    await assertPlayersNotSuspendedAndAudit(
      [requesterUid], 'suspended_booking_rejected',
      requesterUid, requesterName, '', 'submitBookingExtensionRequest',
    );

    const candidate = {
      date,
      court,
      startTime,
      endTime,
      mode: 'general',
      status: 'active',
      createdBy: requesterUid,
      players: [requesterUid],
    };
    const startMs = bookingStartMs(candidate);
    if (!Number.isFinite(startMs) || startMs <= Date.now()) {
      throw new HttpsError(
        'failed-precondition',
        '加時申請時段已開始或已結束，無法送出。',
      );
    }

    const sameDateSnap = await bookingDb.collection('bookings')
      .where('date', '==', date).get();
    const sameDateBookings = sameDateSnap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() || {}),
    }));
    if (hasApprovedExtension(sameDateBookings, requesterUid)) {
      throw new HttpsError(
        'failed-precondition',
        '您今日已有一筆核准的加時預約，無法再次申請。',
      );
    }
    if (normalGeneralMinutesForUid(sameDateBookings, requesterUid) !== 120) {
      throw new HttpsError(
        'failed-precondition',
        '當日一般預約使用時間達 2 小時後，才能申請加時。',
      );
    }
    if (findCourtConflict(sameDateBookings, candidate, '')) {
      throw new HttpsError('already-exists', '申請時段已有其他預約。');
    }
    if (findParticipantConflictUid(sameDateBookings, candidate, '')) {
      throw new HttpsError(
        'failed-precondition',
        '您在申請時段已有其他預約。',
      );
    }
    assertHardCourtUsageAllowed(
      sameDateBookings, requesterUid, startTime, endTime, '',
    );

    const requestId = extensionRequestDocId(requesterUid, date);
    const requestRef = bookingDb.collection('bookingExtensionRequests')
      .doc(requestId);
    try {
      await bookingDb.runTransaction(async (transaction) => {
        const existingSnap = await transaction.get(requestRef);
        await assertPlayersNotSuspendedInTransaction(
          transaction, [requesterUid], 'suspended_booking_rejected',
        );
      const existing = existingSnap.exists ? existingSnap.data() || {} : {};
      const existingStart = existingSnap.exists ? bookingStartMs(existing) : NaN;
      if (existing.status === 'approved' || existing.status === 'revoked') {
        throw new HttpsError(
          'failed-precondition',
          '您今日已有一筆曾核准的加時預約，無法再次申請。',
        );
      }
      if (existing.status === 'pending' &&
          Number.isFinite(existingStart) && existingStart > Date.now()) {
        throw new HttpsError(
          'already-exists',
          '您今日已有一筆待審核加時申請。',
        );
      }
      if (existing.status === 'pending') {
        transaction.set(
          bookingDb.collection('bookingExtensionAuditLogs').doc(),
          extensionAuditData(
            requestId, '', requesterUid, requesterName, requesterUid,
            'extension_expired', '申請時段開始前未核准',
            existing,
          ),
        );
      }
      const attempt = Number(existing.attempt) || 0;
      transaction.set(requestRef, {
        requesterUid,
        requesterName,
        date,
        court,
        startTime,
        endTime,
        durationMinutes: EXTENSION_DURATION_MINUTES,
        status: 'pending',
        attempt: attempt + 1,
        requestedAt: SERVER_TS(),
        updatedAt: SERVER_TS(),
        approvedByUid: '',
        approvedByName: '',
        approvedAt: null,
        rejectedByUid: '',
        rejectedByName: '',
        rejectedAt: null,
        rejectReason: '',
        bookingId: '',
        source: 'web_callable',
      });
        transaction.set(
        bookingDb.collection('bookingExtensionAuditLogs').doc(),
        extensionAuditData(
          requestId, '', requesterUid, requesterName, requesterUid,
          'extension_requested', '',
          {date, court, startTime, endTime, attempt: attempt + 1},
        ),
        );
      });
    } catch (error) {
      await recordSuspensionRejection(
        error, requesterUid, requesterName, '',
        'submitBookingExtensionRequest',
      );
      throw error;
    }
    return {ok: true, requestId};
  },
);

exports.approveBookingExtensionRequest = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const identity = await getAuthenticatedMember(request);
    const actorUid = identity.memberUid;
    const actor = identity.member;
    if (!ADMIN_ROLES.has(actor.role || '')) {
      throw new HttpsError('permission-denied', '僅管理員可核准加時申請');
    }
    const actorName = memberDisplayName(actor, actorUid);
    const requestId = cleanString(request.data && request.data.requestId, 600);
    if (!requestId) {
      throw new HttpsError('invalid-argument', '缺少加時申請 ID');
    }
    const requestRef = bookingDb.collection('bookingExtensionRequests')
      .doc(requestId);
    const preliminaryRequestSnap = await requestRef.get();
    if (preliminaryRequestSnap.exists) {
      const preliminaryRequest = preliminaryRequestSnap.data() || {};
      if (preliminaryRequest.requesterUid) {
        await normaliseExpiredViolationCycle(
          preliminaryRequest.requesterUid,
          actorUid,
          actorName,
          'approveBookingExtensionRequest',
        );
        await assertPlayersNotSuspendedAndAudit(
          [preliminaryRequest.requesterUid],
          'suspended_booking_rejected',
          actorUid, actorName, '', 'approveBookingExtensionRequest',
        );
      }
    }
    let expired = false;
    let bookingId = '';
    try {
      await bookingDb.runTransaction(async (transaction) => {
      const extensionSnap = await transaction.get(requestRef);
      if (!extensionSnap.exists) {
        throw new HttpsError('not-found', '找不到加時申請');
      }
      const extensionRequest = Object.assign(
        {id: requestId}, extensionSnap.data() || {},
      );
      if (extensionRequest.status !== 'pending') {
        throw new HttpsError('failed-precondition', '此申請已處理');
      }
      assertExtensionTimeInput(
        extensionRequest.date,
        extensionRequest.court,
        extensionRequest.startTime,
        extensionRequest.endTime,
      );
      await assertBookingWithinOpenHours(
        extensionRequest.date,
        extensionRequest.startTime,
        extensionRequest.endTime,
        transaction,
      );
      if (bookingStartMs(extensionRequest) <= Date.now()) {
        expired = true;
        transaction.update(requestRef, {
          status: 'expired',
          updatedAt: SERVER_TS(),
        });
        transaction.set(
          bookingDb.collection('bookingExtensionAuditLogs').doc(),
          extensionAuditData(
            requestId, '', actorUid, actorName,
            extensionRequest.requesterUid,
            'extension_expired', '申請時段開始前未核准',
            extensionRequest,
          ),
        );
        return;
      }

      const memberRef = bookingDb.collection('members')
        .doc(extensionRequest.requesterUid);
      const memberSnap = await transaction.get(memberRef);
      if (!memberSnap.exists) {
        throw new HttpsError('failed-precondition', '找不到申請會員資料');
      }
      const member = memberSnap.data() || {};
      await assertMembersHaveBookingAccessInTransaction(
        transaction, [extensionRequest.requesterUid], extensionRequest.date,
      );

      bookingId = `extension_${requestId}`;
      const bookingRef = bookingDb.collection('bookings').doc(bookingId);
      const lockRef = bookingDb.collection('bookingMutationLocks')
        .doc(bookingDateLockId(extensionRequest.date));
      const bookingSnap = await transaction.get(bookingRef);
      await transaction.get(lockRef);
      const sameDateSnap = await transaction.get(
        bookingDb.collection('bookings')
          .where('date', '==', extensionRequest.date),
      );
      await assertPlayersNotSuspendedInTransaction(
        transaction,
        [extensionRequest.requesterUid],
        'suspended_booking_rejected',
      );
      if (bookingSnap.exists) {
        throw new HttpsError('already-exists', '此加時預約已建立');
      }
      const sameDateBookings = sameDateSnap.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() || {}),
      }));
      if (hasApprovedExtension(
        sameDateBookings, extensionRequest.requesterUid,
      )) {
        throw new HttpsError(
          'failed-precondition',
          '此會員今日已有一筆核准的加時預約。',
        );
      }
      if (normalGeneralMinutesForUid(
        sameDateBookings, extensionRequest.requesterUid,
      ) !== 120) {
        throw new HttpsError(
          'failed-precondition',
          '此會員當日正常一般預約時數已變更，無法核准。',
        );
      }

      const requesterName = memberDisplayName(
        member, extensionRequest.requesterUid,
      );
      const booking = {
        date: extensionRequest.date,
        court: extensionRequest.court,
        startTime: extensionRequest.startTime,
        endTime: extensionRequest.endTime,
        mode: 'general',
        status: 'active',
        createdBy: extensionRequest.requesterUid,
        createdByName: requesterName,
        primaryName: requesterName,
        players: [extensionRequest.requesterUid],
        guests: [],
        capacity: 1,
        participantCount: 1,
        extensionStatus: 'approved',
        extensionRequestId: requestId,
        extensionApprovedByUid: actorUid,
        extensionApprovedByName: actorName,
        extensionApprovedAt: SERVER_TS(),
        createdAt: SERVER_TS(),
        updatedAt: SERVER_TS(),
      };
      if (findCourtConflict(sameDateBookings, booking, '')) {
        throw new HttpsError('already-exists', '申請時段已有其他預約。');
      }
      if (findParticipantConflictUid(sameDateBookings, booking, '')) {
        throw new HttpsError(
          'failed-precondition',
          '申請會員在此時段已有其他預約。',
        );
      }
      assertHardCourtUsageAllowed(
        sameDateBookings,
        extensionRequest.requesterUid,
        extensionRequest.startTime,
        extensionRequest.endTime,
        '',
      );

      transaction.set(lockRef, {
        updatedAt: SERVER_TS(),
        version: admin.firestore.FieldValue.increment(1),
      }, {merge: true});
      transaction.set(bookingRef, booking);
      transaction.update(requestRef, {
        requesterName,
        status: 'approved',
        approvedByUid: actorUid,
        approvedByName: actorName,
        approvedAt: SERVER_TS(),
        bookingId,
        updatedAt: SERVER_TS(),
      });
      transaction.set(
        bookingDb.collection('bookingExtensionAuditLogs').doc(),
        extensionAuditData(
          requestId, bookingId, actorUid, actorName,
          extensionRequest.requesterUid, 'extension_approved', '',
          extensionRequest,
        ),
      );
      transaction.set(
        bookingDb.collection('notifications')
          .doc(`booking_extension_approved_${requestId}`),
        extensionNotificationData(
          extensionRequest, 'booking_extension_approved', bookingId,
          actorUid, actorName, '',
        ),
      );
      });
    } catch (error) {
      const targetUid = preliminaryRequestSnap.exists ?
        (preliminaryRequestSnap.data() || {}).requesterUid || '' : '';
      await recordSuspensionRejection(
        error, actorUid, actorName, bookingId,
        'approveBookingExtensionRequest',
      );
      if (error && error.details && !error.details.memberUid && targetUid) {
        error.details.memberUid = targetUid;
      }
      throw error;
    }
    if (expired) {
      throw new HttpsError(
        'deadline-exceeded',
        '此加時申請已超過開始時間，已標記為 expired。',
      );
    }
    return {ok: true, bookingId};
  },
);

exports.rejectBookingExtensionRequest = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const identity = await getAuthenticatedMember(request);
    const actorUid = identity.memberUid;
    const actor = identity.member;
    if (!ADMIN_ROLES.has(actor.role || '')) {
      throw new HttpsError('permission-denied', '僅管理員可拒絕加時申請');
    }
    const actorName = memberDisplayName(actor, actorUid);
    const requestId = cleanString(request.data && request.data.requestId, 600);
    const reason = cleanString(request.data && request.data.reason, 300) ||
      '加時申請未通過';
    if (!requestId) {
      throw new HttpsError('invalid-argument', '缺少加時申請 ID');
    }
    const requestRef = bookingDb.collection('bookingExtensionRequests')
      .doc(requestId);
    let expired = false;
    await bookingDb.runTransaction(async (transaction) => {
      const extensionSnap = await transaction.get(requestRef);
      if (!extensionSnap.exists) {
        throw new HttpsError('not-found', '找不到加時申請');
      }
      const extensionRequest = Object.assign(
        {id: requestId}, extensionSnap.data() || {},
      );
      if (extensionRequest.status !== 'pending') {
        throw new HttpsError('failed-precondition', '此申請已處理');
      }
      if (bookingStartMs(extensionRequest) <= Date.now()) {
        expired = true;
        transaction.update(requestRef, {
          status: 'expired',
          updatedAt: SERVER_TS(),
        });
        transaction.set(
          bookingDb.collection('bookingExtensionAuditLogs').doc(),
          extensionAuditData(
            requestId, '', actorUid, actorName,
            extensionRequest.requesterUid,
            'extension_expired', '申請時段開始前未核准',
            extensionRequest,
          ),
        );
        return;
      }
      transaction.update(requestRef, {
        status: 'rejected',
        rejectedByUid: actorUid,
        rejectedByName: actorName,
        rejectedAt: SERVER_TS(),
        rejectReason: reason,
        updatedAt: SERVER_TS(),
      });
      transaction.set(
        bookingDb.collection('bookingExtensionAuditLogs').doc(),
        extensionAuditData(
          requestId, '', actorUid, actorName,
          extensionRequest.requesterUid, 'extension_rejected', reason,
          extensionRequest,
        ),
      );
      transaction.set(
        bookingDb.collection('notifications')
          .doc(`booking_extension_rejected_${requestId}_${extensionRequest.attempt || 1}`),
        extensionNotificationData(
          extensionRequest, 'booking_extension_rejected', '',
          actorUid, actorName, reason,
        ),
      );
    });
    if (expired) {
      throw new HttpsError(
        'deadline-exceeded',
        '此加時申請已超過開始時間，已標記為 expired。',
      );
    }
    return {ok: true};
  },
);

async function getViolationActor(request, ownerOnly) {
  const identity = await getAuthenticatedMember(request);
  const actorUid = identity.memberUid;
  const actor = identity.member;
  const allowed = ownerOnly ? actor.role === 'owner' :
    ADMIN_ROLES.has(actor.role || '');
  if (!allowed) {
    throw new HttpsError(
      'permission-denied',
      ownerOnly ? '僅開發者可永久刪除違規紀錄' : '僅管理員可執行違規記點操作',
    );
  }
  return {
    actorUid,
    actor,
    actorName: memberDisplayName(actor, actorUid),
  };
}

function assertViolationTargetAllowed(actorUid, targetUid, target) {
  if (actorUid === targetUid) {
    throw new HttpsError('permission-denied', '不可對自己記點');
  }
  if (target.role !== 'member' && target.role !== 'coach') {
    throw new HttpsError('permission-denied', '僅可對一般會員或教練記點');
  }
}

function revokedViolationNotificationData(
  violation, actorUid, actorName, reason, activePoints,
) {
  return {
    uid: violation.memberUid,
    type: 'booking_violation_revoked',
    action: 'violation_revoke',
    title: '違規記點已撤銷',
    violationId: violation.id,
    bookingId: violation.bookingId || '',
    violationReason: violation.violationReason || '',
    revokedByUid: actorUid,
    revokedByName: actorName,
    revokeReason: reason,
    activePoints,
    message: `違規記點已撤銷。撤銷原因：${reason}\n目前有效點數：${activePoints} / ${VIOLATION_LIMIT}`,
    createdAt: SERVER_TS(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ),
    read: false,
  };
}

exports.createBookingViolation = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const {actorUid, actorName} = await getViolationActor(request, false);
    const data = request.data || {};
    const requestedTargetUid = cleanString(data.targetUid, 128);
    const bookingId = cleanString(data.bookingId, 128);
    const violationType = cleanString(data.violationType, 40);
    const note = cleanString(data.note, 500);
    if (!VIOLATION_TYPES.has(violationType)) {
      throw new HttpsError('invalid-argument', '違規原因不正確');
    }
    if (violationType === 'other' && !note) {
      throw new HttpsError('invalid-argument', '其他原因必須填寫備註');
    }
    if ((violationType === 'no_show' ||
         violationType === 'roster_mismatch') && !bookingId) {
      throw new HttpsError('invalid-argument', '此違規原因必須選擇對應預約');
    }

    let booking = null;
    let targetUid = requestedTargetUid;
    if (bookingId) {
      const bookingSnap = await bookingDb.collection('bookings').doc(bookingId).get();
      if (!bookingSnap.exists) {
        throw new HttpsError('not-found', '找不到對應預約');
      }
      booking = bookingSnap.data() || {};
      if (violationType === 'roster_mismatch') {
        targetUid = cleanString(booking.createdBy, 128);
      }
    }
    if (!targetUid) {
      throw new HttpsError('invalid-argument', '缺少記點會員');
    }
    const targetRef = bookingDb.collection('members').doc(targetUid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      throw new HttpsError('not-found', '找不到記點會員');
    }
    const target = targetSnap.data() || {};
    assertViolationTargetAllowed(actorUid, targetUid, target);
    if (violationType === 'no_show') {
      if (!booking || !isActiveBooking(booking) ||
          !Array.isArray(booking.players) ||
          !booking.players.includes(targetUid)) {
        throw new HttpsError(
          'failed-precondition',
          '預約未到只能記在該筆有效預約的參與會員身上',
        );
      }
    }
    if (violationType === 'roster_mismatch' &&
        (!booking || !isActiveBooking(booking) ||
         booking.createdBy !== targetUid)) {
      throw new HttpsError(
        'failed-precondition',
        '名單不符必須記在該筆有效預約的建立者身上',
      );
    }

    await normaliseExpiredViolationCycle(
      targetUid, actorUid, actorName, 'createBookingViolation',
    );
    const violationRef = bookingDb.collection('bookingViolations').doc();
    const summaryRef = violationSummaryRef(targetUid);
    const actorRef = bookingDb.collection('members').doc(actorUid);
    const bookingRef = bookingId ?
      bookingDb.collection('bookings').doc(bookingId) : null;
    await bookingDb.runTransaction(async (transaction) => {
      const actorCurrentSnap = await transaction.get(actorRef);
      const targetCurrentSnap = await transaction.get(targetRef);
      const bookingCurrentSnap = bookingRef ?
        await transaction.get(bookingRef) : null;
      const summarySnap = await transaction.get(summaryRef);
      const actorCurrent = actorCurrentSnap.exists ?
        actorCurrentSnap.data() || {} : {};
      if (!ADMIN_ROLES.has(actorCurrent.role || '')) {
        throw new HttpsError('permission-denied', '僅管理員可執行違規記點操作');
      }
      if (!targetCurrentSnap.exists) {
        throw new HttpsError('not-found', '找不到記點會員');
      }
      const targetCurrent = targetCurrentSnap.data() || {};
      assertViolationTargetAllowed(actorUid, targetUid, targetCurrent);
      const bookingCurrent = bookingCurrentSnap && bookingCurrentSnap.exists ?
        bookingCurrentSnap.data() || {} : null;
      if (violationType === 'no_show' &&
          (!bookingCurrent || !isActiveBooking(bookingCurrent) ||
           !Array.isArray(bookingCurrent.players) ||
           !bookingCurrent.players.includes(targetUid))) {
        throw new HttpsError('failed-precondition', '對應預約或會員名單已變更');
      }
      if (violationType === 'roster_mismatch' &&
          (!bookingCurrent || !isActiveBooking(bookingCurrent) ||
           bookingCurrent.createdBy !== targetUid)) {
        throw new HttpsError('failed-precondition', '對應預約建立者已變更');
      }

      const summary = summarySnap.exists ? summarySnap.data() || {} : {};
      const suspendedUntilMs = timestampMillis(summary.bookingSuspendedUntil);
      const cycleExpired = summary.status === 'suspended' &&
        suspendedUntilMs > 0 && suspendedUntilMs <= Date.now();
      const currentlySuspended = summary.status === 'suspended' &&
        suspendedUntilMs > Date.now();
      const previousPoints = cycleExpired ? 0 :
        (Number(summary.activePoints) || 0);
      const countsTowardCycle = !currentlySuspended;
      const activePoints = countsTowardCycle ?
        Math.min(VIOLATION_LIMIT, previousPoints + 1) : previousPoints;
      const cycleId = cycleExpired ? violationRef.id :
        (summary.cycleId || violationRef.id);
      const cycleViolationIds = cycleExpired ? [] :
        (Array.isArray(summary.cycleViolationIds) ?
          summary.cycleViolationIds.slice() : []);
      if (countsTowardCycle) cycleViolationIds.push(violationRef.id);
      const startsSuspension = countsTowardCycle &&
        previousPoints < VIOLATION_LIMIT && activePoints === VIOLATION_LIMIT;
      const nowMillis = Date.now();
      const suspensionUntilMs = startsSuspension ?
        addTaipeiCalendarMonth(nowMillis) : suspendedUntilMs;
      const bookingSnapshot = bookingCurrent || booking || {};
      const violation = {
        id: violationRef.id,
        memberUid: targetUid,
        memberName: memberDisplayName(targetCurrent, targetUid),
        bookingId: bookingId || '',
        bookingDate: bookingSnapshot.date || '',
        court: bookingSnapshot.court || '',
        startTime: bookingSnapshot.startTime || '',
        endTime: bookingSnapshot.endTime || '',
        violationType,
        violationReason: VIOLATION_REASON_LABELS[violationType],
        note,
        points: 1,
        status: 'active',
        cycleId,
        countsTowardCycle,
        cycleStatus: currentlySuspended ? 'suspended_unscored' : 'current',
        createdByUid: actorUid,
        createdByName: memberDisplayName(actorCurrent, actorUid),
        createdAt: SERVER_TS(),
        revokedByUid: '',
        revokedByName: '',
        revokedAt: null,
        revokeReason: '',
        suspensionTriggered: startsSuspension,
        suspensionStartedAt: startsSuspension ?
          admin.firestore.Timestamp.fromMillis(nowMillis) : null,
        suspensionUntil: startsSuspension ?
          admin.firestore.Timestamp.fromMillis(suspensionUntilMs) : null,
      };
      const summaryAfter = {
        memberUid: targetUid,
        memberName: violation.memberName,
        cycleId,
        cycleViolationIds,
        activePoints,
        status: startsSuspension || currentlySuspended ? 'suspended' : 'active',
        cycleStartedAt: cycleExpired ? SERVER_TS() :
          (summary.cycleStartedAt || SERVER_TS()),
        bookingSuspendedAt: startsSuspension ?
          admin.firestore.Timestamp.fromMillis(nowMillis) :
          (cycleExpired ? null : (summary.bookingSuspendedAt || null)),
        bookingSuspendedUntil: startsSuspension ?
          admin.firestore.Timestamp.fromMillis(suspensionUntilMs) :
          (cycleExpired ? null : (summary.bookingSuspendedUntil || null)),
        suspensionTriggerViolationId: startsSuspension ?
          violationRef.id :
          (cycleExpired ? '' : (summary.suspensionTriggerViolationId || '')),
        updatedAt: SERVER_TS(),
      };
      transaction.set(violationRef, violation);
      transaction.set(summaryRef, summaryAfter, {merge: true});
      if (cycleExpired) {
        transaction.set(
          bookingDb.collection('bookingViolationAuditLogs').doc(),
          violationAuditData({
            action: 'suspension_end',
            actorUid,
            actorName: violation.createdByName,
            targetUid,
            targetName: violation.memberName,
            violationId: summary.suspensionTriggerViolationId || '',
            before: {
              cycleId: summary.cycleId || '',
              activePoints: Number(summary.activePoints) || 0,
              status: 'suspended',
            },
            after: {cycleId, activePoints, status: 'active'},
            reason: '預約停權期限已屆滿，開始新的違規點數週期',
            source: 'createBookingViolation',
          }),
        );
      }
      transaction.set(
        bookingDb.collection('bookingViolationAuditLogs').doc(),
        violationAuditData({
          action: 'violation_create',
          actorUid,
          actorName: violation.createdByName,
          targetUid,
          targetName: violation.memberName,
          bookingId,
          violationId: violationRef.id,
          before: {activePoints: previousPoints, cycleId: summary.cycleId || ''},
          after: {activePoints, cycleId, countsTowardCycle},
          reason: violation.violationReason,
          source: 'createBookingViolation',
        }),
      );
      if (startsSuspension) {
        transaction.set(
          bookingDb.collection('bookingViolationAuditLogs').doc(),
          violationAuditData({
            action: 'suspension_start',
            actorUid,
            actorName: violation.createdByName,
            targetUid,
            targetName: violation.memberName,
            bookingId,
            violationId: violationRef.id,
            before: {activePoints: previousPoints, status: 'active'},
            after: {
              activePoints,
              status: 'suspended',
              bookingSuspendedUntil: suspensionUntilMs,
            },
            reason: '目前週期累積 3 點，暫停預約資格一個曆月',
            source: 'createBookingViolation',
          }),
        );
      }
      transaction.set(
        bookingDb.collection('notifications')
          .doc(`booking_violation_${violationRef.id}`),
        violationNotificationData(
          violation,
          activePoints,
          startsSuspension ? nowMillis : 0,
          startsSuspension ? suspensionUntilMs : 0,
        ),
      );
    });
    return {ok: true, violationId: violationRef.id, memberUid: targetUid};
  },
);

async function applyViolationRemovalToSummary(
  transaction, summaryRef, summary, violation, actorUid, actorName,
  actionReason, source,
) {
  const belongsToCurrentCycle = violation.countsTowardCycle === true &&
    violation.cycleId && violation.cycleId === summary.cycleId;
  if (!belongsToCurrentCycle) return Number(summary.activePoints) || 0;
  const beforePoints = Number(summary.activePoints) || 0;
  const activePoints = Math.max(0, beforePoints - Number(violation.points || 1));
  const cycleViolationIds = (Array.isArray(summary.cycleViolationIds) ?
    summary.cycleViolationIds : []).filter((id) => id !== violation.id);
  const wasSuspended = summary.status === 'suspended';
  const clearsSuspension = wasSuspended && activePoints < VIOLATION_LIMIT;
  transaction.set(summaryRef, {
    activePoints,
    cycleId: activePoints === 0 ? '' : summary.cycleId,
    cycleViolationIds,
    status: clearsSuspension ? 'active' : (summary.status || 'active'),
    cycleStartedAt: activePoints === 0 ? null : (summary.cycleStartedAt || null),
    bookingSuspendedAt: clearsSuspension ? null :
      (summary.bookingSuspendedAt || null),
    bookingSuspendedUntil: clearsSuspension ? null :
      (summary.bookingSuspendedUntil || null),
    suspensionTriggerViolationId: clearsSuspension ? '' :
      (summary.suspensionTriggerViolationId || ''),
    suspensionEndedAt: clearsSuspension ? SERVER_TS() :
      (summary.suspensionEndedAt || null),
    updatedAt: SERVER_TS(),
  }, {merge: true});
  if (clearsSuspension) {
    transaction.set(
      bookingDb.collection('bookingViolationAuditLogs').doc(),
      violationAuditData({
        action: 'suspension_end',
        actorUid,
        actorName,
        targetUid: violation.memberUid,
        targetName: violation.memberName,
        bookingId: violation.bookingId || '',
        violationId: violation.id,
        before: {activePoints: beforePoints, status: 'suspended'},
        after: {activePoints, status: 'active'},
        reason: actionReason,
        source,
      }),
    );
  }
  return activePoints;
}

exports.revokeBookingViolation = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const {actorUid, actorName} = await getViolationActor(request, false);
    const violationId = cleanString(request.data && request.data.violationId, 128);
    const revokeReason = cleanString(request.data && request.data.revokeReason, 500);
    if (!violationId || !revokeReason) {
      throw new HttpsError('invalid-argument', '違規紀錄與撤銷原因必填');
    }
    const violationRef = bookingDb.collection('bookingViolations').doc(violationId);
    const initialSnap = await violationRef.get();
    if (!initialSnap.exists) throw new HttpsError('not-found', '找不到違規紀錄');
    const initial = initialSnap.data() || {};
    await normaliseExpiredViolationCycle(
      initial.memberUid, actorUid, actorName, 'revokeBookingViolation',
    );
    let activePoints = 0;
    await bookingDb.runTransaction(async (transaction) => {
      const actorSnap = await transaction.get(
        bookingDb.collection('members').doc(actorUid));
      const violationSnap = await transaction.get(violationRef);
      const summaryRef = violationSummaryRef(initial.memberUid);
      const summarySnap = await transaction.get(summaryRef);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (!ADMIN_ROLES.has(actor.role || '')) {
        throw new HttpsError('permission-denied', '僅管理員可撤銷違規記點');
      }
      if (!violationSnap.exists) throw new HttpsError('not-found', '找不到違規紀錄');
      const violation = Object.assign({id: violationId}, violationSnap.data() || {});
      if (violation.status !== 'active') {
        throw new HttpsError('failed-precondition', '此違規紀錄已撤銷');
      }
      const summary = summarySnap.exists ? summarySnap.data() || {} : {};
      activePoints = await applyViolationRemovalToSummary(
        transaction, summaryRef, summary, violation,
        actorUid, memberDisplayName(actor, actorUid),
        `撤銷記點：${revokeReason}`, 'revokeBookingViolation',
      );
      transaction.update(violationRef, {
        status: 'revoked',
        revokedByUid: actorUid,
        revokedByName: memberDisplayName(actor, actorUid),
        revokedAt: SERVER_TS(),
        revokeReason,
      });
      transaction.set(
        bookingDb.collection('bookingViolationAuditLogs').doc(),
        violationAuditData({
          action: 'violation_revoke',
          actorUid,
          actorName: memberDisplayName(actor, actorUid),
          targetUid: violation.memberUid,
          targetName: violation.memberName,
          bookingId: violation.bookingId || '',
          violationId,
          before: {status: 'active', activePoints: Number(summary.activePoints) || 0},
          after: {status: 'revoked', activePoints},
          reason: revokeReason,
          source: 'revokeBookingViolation',
        }),
      );
      transaction.set(
        bookingDb.collection('notifications')
          .doc(`booking_violation_revoked_${violationId}`),
        revokedViolationNotificationData(
          violation, actorUid, memberDisplayName(actor, actorUid),
          revokeReason, activePoints,
        ),
      );
    });
    return {ok: true, violationId, activePoints};
  },
);

exports.deleteBookingViolation = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const {actorUid, actorName} = await getViolationActor(request, true);
    const violationId = cleanString(request.data && request.data.violationId, 128);
    const deleteReason = cleanString(request.data && request.data.deleteReason, 500);
    if (!violationId || !deleteReason) {
      throw new HttpsError('invalid-argument', '違規紀錄與刪除原因必填');
    }
    const violationRef = bookingDb.collection('bookingViolations').doc(violationId);
    const initialSnap = await violationRef.get();
    if (!initialSnap.exists) throw new HttpsError('not-found', '找不到違規紀錄');
    const initial = initialSnap.data() || {};
    await normaliseExpiredViolationCycle(
      initial.memberUid, actorUid, actorName, 'deleteBookingViolation',
    );
    let activePoints = 0;
    await bookingDb.runTransaction(async (transaction) => {
      const actorSnap = await transaction.get(
        bookingDb.collection('members').doc(actorUid));
      const violationSnap = await transaction.get(violationRef);
      const summaryRef = violationSummaryRef(initial.memberUid);
      const summarySnap = await transaction.get(summaryRef);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (actor.role !== 'owner') {
        throw new HttpsError('permission-denied', '僅開發者可永久刪除違規紀錄');
      }
      if (!violationSnap.exists) throw new HttpsError('not-found', '找不到違規紀錄');
      const violation = Object.assign({id: violationId}, violationSnap.data() || {});
      const summary = summarySnap.exists ? summarySnap.data() || {} : {};
      activePoints = Number(summary.activePoints) || 0;
      if (violation.status === 'active') {
        activePoints = await applyViolationRemovalToSummary(
          transaction, summaryRef, summary, violation,
          actorUid, memberDisplayName(actor, actorUid),
          `永久刪除違規紀錄：${deleteReason}`, 'deleteBookingViolation',
        );
      }
      transaction.set(
        bookingDb.collection('bookingViolationAuditLogs').doc(),
        violationAuditData({
          action: 'violation_delete',
          actorUid,
          actorName: memberDisplayName(actor, actorUid),
          targetUid: violation.memberUid,
          targetName: violation.memberName,
          bookingId: violation.bookingId || '',
          violationId,
          before: violation,
          after: {deleted: true, activePoints},
          reason: deleteReason,
          source: 'deleteBookingViolation',
        }),
      );
      transaction.delete(violationRef);
    });
    return {ok: true, violationId, activePoints};
  },
);

exports.restoreFinancialRecord = onCall({region: 'asia-east1'}, async (request) => {
  const identity = await getAuthenticatedMember(request);
  const actorUid = identity.memberUid;
  const actor = identity.member;
  if (actor.role !== 'owner') {
    throw new HttpsError('permission-denied', '僅 Owner 可恢復財務紀錄');
  }
  const actorName = cleanString(
    actor.realName || actor.name || actor.displayName,
    100,
  );
  if (!actorName) {
    throw new HttpsError('failed-precondition', '找不到 Owner 正式姓名');
  }

  const recordId = cleanString(request.data && request.data.recordId, 200);
  if (!recordId) {
    throw new HttpsError('invalid-argument', '缺少財務紀錄 ID');
  }
  const recordRef = bookingDb.collection('financialRecords').doc(recordId);
  const recordSnap = await recordRef.get();
  if (!recordSnap.exists) {
    throw new HttpsError('not-found', '找不到財務紀錄');
  }
  if ((recordSnap.data().status || 'active') !== 'void') {
    throw new HttpsError('failed-precondition', '只能恢復已作廢的財務紀錄');
  }

  const batch = bookingDb.batch();
  batch.update(recordRef, {status: 'active'});
  batch.set(bookingDb.collection('financialAuditLogs').doc(), {
    recordId,
    action: 'restore',
    restoredByUid: actorUid,
    restoredByName: actorName,
    restoredAt: SERVER_TS(),
  });
  await batch.commit();
  return {ok: true, recordId};
});

function canonicalMergeValue(value) {
  if (value == null) return value;
  if (typeof value.toMillis === 'function') {
    return {__timestampMillis: value.toMillis()};
  }
  if (Array.isArray(value)) return value.map(canonicalMergeValue);
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalMergeValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function memberMergeHash(value) {
  const encoded = JSON.stringify(canonicalMergeValue(value));
  return crypto.createHash('sha256')
    .update(encoded === undefined ? '__undefined__' : encoded, 'utf8')
    .digest('hex');
}

function bookingContainsMemberUid(booking, uid) {
  if (!booking || !uid) return false;
  return booking.createdBy === uid || booking.coachId === uid ||
    (Array.isArray(booking.players) && booking.players.includes(uid)) ||
    (Array.isArray(booking.students) && booking.students.includes(uid)) ||
    Boolean(booking.attendance &&
      Object.prototype.hasOwnProperty.call(booking.attendance, uid));
}

function replaceMemberUidInBooking(booking, sourceUid, targetUid) {
  const after = Object.assign({}, booking);
  if (after.createdBy === sourceUid) after.createdBy = targetUid;
  if (after.coachId === sourceUid) after.coachId = targetUid;
  if (Array.isArray(after.players)) {
    after.players = after.players.map((uid) =>
      uid === sourceUid ? targetUid : uid);
  }
  if (Array.isArray(after.students)) {
    after.students = after.students.map((uid) =>
      uid === sourceUid ? targetUid : uid);
  }
  if (after.attendance &&
      Object.prototype.hasOwnProperty.call(after.attendance, sourceUid)) {
    after.attendance = Object.assign({}, after.attendance, {
      [targetUid]: after.attendance[sourceUid],
    });
    delete after.attendance[sourceUid];
  }
  return after;
}

function memberMergeMembership(member) {
  return {
    membershipType: cleanString(member && member.membershipType, 30),
    membershipExpiry: normaliseExpiryDate(
      member && (member.membershipExpiry || member.expireDate || ''),
    ),
  };
}

function memberMergeSnapshotMatches(snapshot, member) {
  if (!snapshot) return false;
  const fields = [
    'uid', 'realName', 'displayName', 'role', 'status', 'membershipType',
    'memberSource', 'approved', 'createdAt',
  ];
  return fields.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(snapshot, field)) return true;
    if (field === 'createdAt') {
      return memberMergeHash(snapshot[field]) === memberMergeHash(member[field]);
    }
    if (field === 'approved') {
      return (snapshot[field] === true) === (member[field] === true);
    }
    return cleanString(snapshot[field], 200) === cleanString(member[field], 200);
  });
}

function memberMergeSnapshotDiffValue(field, value) {
  if (field === 'approved') return value === true;
  if (field === 'membershipExpiry') {
    return normaliseExpiryDate(value || '');
  }
  if (field === 'createdAt') {
    const canonical = canonicalMergeValue(value);
    if (canonical && canonical.__timestampMillis != null) {
      return new Date(canonical.__timestampMillis).toISOString();
    }
    return canonical || null;
  }
  return value == null ? '' : cleanString(String(value), 200);
}

function memberMergeSnapshotDifferences(snapshot, member, memberType) {
  if (!snapshot) {
    return [{memberType, field: 'snapshot', before: null, after: 'missing'}];
  }
  const fields = [
    'uid', 'realName', 'displayName', 'role', 'status', 'membershipType',
    'membershipExpiry', 'memberSource', 'approved', 'ntrp',
    'preferredPosition', 'createdAt',
  ];
  return fields.reduce((differences, field) => {
    if (!Object.prototype.hasOwnProperty.call(snapshot, field)) {
      return differences;
    }
    const before = memberMergeSnapshotDiffValue(field, snapshot[field]);
    const after = memberMergeSnapshotDiffValue(field,
      field === 'membershipExpiry' ?
        member.membershipExpiry || member.expireDate || '' : member[field]);
    if (memberMergeHash(before) !== memberMergeHash(after)) {
      differences.push({memberType, field, before, after});
    }
    return differences;
  }, []);
}

function buildRevalidatedMemberMergeCandidate(
  candidate, lineUid, lineMember, manualUid, manualMember, actor, revalidatedAt,
) {
  return Object.assign({}, candidate, {
    initialLineMember: candidate.initialLineMember || candidate.lineMember,
    initialManualMember: candidate.initialManualMember || candidate.manualMember,
    lineMember: duplicateMemberSnapshot(lineUid, lineMember, 'line'),
    manualMember: duplicateMemberSnapshot(manualUid, manualMember, 'manual'),
    snapshotVersion: Math.max(1, Number(candidate.snapshotVersion) || 1) + 1,
    revalidationCount: (Number(candidate.revalidationCount) || 0) + 1,
    lastRevalidatedAt: revalidatedAt,
    lastRevalidatedByUid: actor.uid,
    lastRevalidatedByName: actor.name,
  });
}

function memberMergeFinanceKey(record) {
  const status = record.status || 'active';
  if (status !== 'active') return '';
  const type = cleanString(record.type || record.membershipType, 30);
  if (type === 'annual') {
    const rawYear = record.membershipYear || record.year ||
      cleanString(record.date, 10).slice(0, 4);
    const year = cleanString(String(rawYear || ''), 4);
    return year ? `annual:${year}` : '';
  }
  if (type === 'monthly') {
    const year = cleanString(String(
      record.billingYear || record.year || '',
    ), 4);
    const monthNumber = Number(record.billingMonth || record.month || 0);
    if (year && monthNumber >= 1 && monthNumber <= 12) {
      return `monthly:${year}-${String(monthNumber).padStart(2, '0')}`;
    }
    const expiry = normaliseExpiryDate(
      record.membershipExpiry || record.expireDate || '',
    );
    return expiry ? `monthly-expiry:${expiry}` : '';
  }
  return '';
}

function membershipPeriodsConflict(firstPeriods, secondPeriods) {
  return (firstPeriods || []).some((first) =>
    (secondPeriods || []).some((second) => {
      const firstData = first.data || first;
      const secondData = second.data || second;
      const firstYear = Number(firstData.membershipYear) || 0;
      const secondYear = Number(secondData.membershipYear) || 0;
      if (firstYear && secondYear && firstYear === secondYear) return true;
      const firstStart = cleanString(firstData.startDate, 10);
      const firstEnd = cleanString(firstData.expiryDate, 10);
      const secondStart = cleanString(secondData.startDate, 10);
      const secondEnd = cleanString(secondData.expiryDate, 10);
      return firstStart && firstEnd && secondStart && secondEnd &&
        firstStart <= secondEnd && secondStart <= firstEnd;
    }));
}

function assessMemberMergeState(state, options) {
  options = options || {};
  const blockers = [];
  const warnings = [];
  const candidate = state.candidate.data;
  const lineMember = state.lineMember.data;
  const manualMember = state.manualMember.data;
  const lineUid = state.lineMember.id;
  const manualUid = state.manualMember.id;
  const lineRole = lineMember.role || 'member';
  const manualRole = manualMember.role || 'member';
  const lineMembership = memberMergeMembership(lineMember);
  const manualMembership = memberMergeMembership(manualMember);
  const snapshotDifferences = [
    ...memberMergeSnapshotDifferences(
      candidate.lineMember, lineMember, 'line'),
    ...memberMergeSnapshotDifferences(
      candidate.manualMember, manualMember, 'manual'),
  ];

  if (candidate.status !== 'pending') blockers.push('候選狀態已不是 pending');
  if (normaliseMemberName(lineMember.realName) !==
      normaliseMemberName(manualMember.realName)) {
    blockers.push('LINE 與手動會員姓名已不一致');
  }
  if (lineMember.memberSource === 'manual' ||
      manualMember.memberSource !== 'manual') {
    blockers.push('會員來源不符合 LINE 主帳號／手動來源帳號');
  }
  if (lineMember.mergedInto || manualMember.mergedInto ||
      lineMember.status === 'merged' || manualMember.status === 'merged') {
    blockers.push('其中一筆會員已被合併');
  }
  if (lineRole !== manualRole ||
      ['admin', 'owner'].includes(lineRole) ||
      ['admin', 'owner'].includes(manualRole)) {
    blockers.push('角色不一致或涉及 admin / owner');
  }
  if (!options.ignoreSnapshotMismatch && snapshotDifferences.length) {
    blockers.push('會員重要資料已與候選建立時不同');
  }
  if (lineMembership.membershipType && manualMembership.membershipType &&
      (lineMembership.membershipType !== manualMembership.membershipType ||
       lineMembership.membershipExpiry !== manualMembership.membershipExpiry)) {
    blockers.push('兩邊都有衝突的會員資格資料');
  }
  if ((lineMembership.membershipType && !lineMembership.membershipExpiry) ||
      (manualMembership.membershipType && !manualMembership.membershipExpiry)) {
    blockers.push('會員資格缺少可安全判定的到期日');
  }
  if (state.lineSummary && state.manualSummary) {
    blockers.push('兩邊都有違規 summary');
  }
  if (membershipPeriodsConflict(
    state.lineMembershipPeriods, state.manualMembershipPeriods,
  )) {
    blockers.push('兩邊有衝突的年度會員資格');
  }
  const lineDecisionYears = new Set((state.lineMembershipYearDecisions || [])
    .filter((item) => item.data.status === 'not_joining')
    .map((item) => Number(item.data.membershipYear)));
  if ((state.manualMembershipYearDecisions || []).some((item) =>
    item.data.status === 'not_joining' &&
    lineDecisionYears.has(Number(item.data.membershipYear)))) {
    blockers.push('兩邊有衝突的年度未加入決定');
  }
  if (Object.keys(lineMember.coachStudents || {}).length ||
      Object.keys(manualMember.coachStudents || {}).length) {
    blockers.push('來源或目標會員本身具有 coachStudents，需 Owner 人工確認');
  }

  state.bookings.forEach((item) => {
    if (bookingContainsMemberUid(item.data, lineUid) &&
        bookingContainsMemberUid(item.data, manualUid)) {
      blockers.push(`booking ${item.id} 同時包含兩個 UID`);
    }
  });
  state.coachMembers.forEach((item) => {
    const students = item.data.coachStudents || {};
    if (Object.prototype.hasOwnProperty.call(students, lineUid) &&
        Object.prototype.hasOwnProperty.call(students, manualUid)) {
      blockers.push(`coach ${item.id} 同時存在兩個 UID`);
    }
  });
  if (state.extensionRequests.length) {
    blockers.push('存在加時申請關聯，需 Owner 人工確認後另行處理');
  }

  const lineFinanceKeys = new Set(state.lineFinancialRecords
    .map((item) => memberMergeFinanceKey(item.data)).filter(Boolean));
  state.manualFinancialRecords.forEach((item) => {
    const type = cleanString(item.data.type || item.data.membershipType, 30);
    const key = memberMergeFinanceKey(item.data);
    if ((item.data.status || 'active') === 'active' &&
        ['annual', 'monthly'].includes(type) && !key) {
      blockers.push(`財務紀錄 ${item.id} 無法安全判定帳期`);
    } else if (key && lineFinanceKeys.has(key)) {
      blockers.push(`財務帳期衝突：${key}`);
    }
  });

  let effectiveMembership = lineMembership;
  if (!effectiveMembership.membershipType && manualMembership.membershipType) {
    effectiveMembership = manualMembership;
  }
  if (!candidate.lineMember || !candidate.manualMember) {
    warnings.push('候選為舊版快照，執行時仍會以本次預覽雜湊防止資料漂移');
  }
  if (manualMember.status === 'deleted') {
    warnings.push('手動來源會員目前為 deleted，重新驗證前需由 Owner 明確確認');
  }

  const counts = {
    financialRecords: state.manualFinancialRecords.length,
    bookings: state.bookings.filter((item) =>
      bookingContainsMemberUid(item.data, manualUid)).length,
    violations: state.manualViolations.length,
    violationSummaries: state.manualSummary ? 1 : 0,
    coachStudents: state.coachMembers.filter((item) =>
      Object.prototype.hasOwnProperty.call(
        item.data.coachStudents || {}, manualUid,
      )).length,
    notifications: state.notifications.length,
    extensionRequests: state.extensionRequests.length,
    membershipPeriods: (state.manualMembershipPeriods || []).length,
    membershipYearDecisions:
      (state.manualMembershipYearDecisions || []).length,
  };
  const hashPayload = {
    candidate: state.candidate,
    lineMember: state.lineMember,
    manualMember: state.manualMember,
    manualFinancialRecords: state.manualFinancialRecords,
    lineFinancialRecords: state.lineFinancialRecords,
    manualMembershipPeriods: state.manualMembershipPeriods,
    lineMembershipPeriods: state.lineMembershipPeriods,
    manualMembershipYearDecisions: state.manualMembershipYearDecisions,
    lineMembershipYearDecisions: state.lineMembershipYearDecisions,
    bookings: state.bookings,
    manualViolations: state.manualViolations,
    lineViolations: state.lineViolations,
    manualSummary: state.manualSummary,
    lineSummary: state.lineSummary,
    coachMembers: state.coachMembers,
    notifications: state.notifications,
    extensionRequests: state.extensionRequests,
    identityLink: state.identityLink,
    identityClaim: state.identityClaim,
    memberIdentityLinks: state.memberIdentityLinks,
  };
  return {
    canMerge: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings,
    counts,
    effectiveMembership,
    snapshotDifferences,
    previewHash: memberMergeHash(hashPayload),
  };
}

function memberMergeDoc(path, snap) {
  return snap && snap.exists ? {path, id: snap.id, data: snap.data() || {}} : null;
}

async function loadMemberMergeState(read, candidateId) {
  const candidateRef = bookingDb.collection('duplicateMemberCandidates')
    .doc(candidateId);
  const candidateSnap = await read(candidateRef);
  if (!candidateSnap.exists) {
    throw new HttpsError('not-found', '找不到疑似重複會員候選');
  }
  const candidate = candidateSnap.data() || {};
  const lineUid = cleanString(candidate.lineMemberUid, 200);
  const manualUid = cleanString(candidate.manualMemberUid, 200);
  if (!lineUid || !manualUid || lineUid === manualUid) {
    throw new HttpsError('failed-precondition', '候選會員 UID 無效');
  }
  const lineRef = bookingDb.collection('members').doc(lineUid);
  const manualRef = bookingDb.collection('members').doc(manualUid);
  const lineSnap = await read(lineRef);
  const manualSnap = await read(manualRef);
  if (!lineSnap.exists || !manualSnap.exists) {
    throw new HttpsError('failed-precondition', 'LINE 或手動會員資料不存在');
  }

  const readQuery = async (query, collectionName) => {
    const snap = await read(query);
    return snap.docs.map((doc) => ({
      path: `${collectionName}/${doc.id}`,
      id: doc.id,
      data: doc.data() || {},
    }));
  };
  const union = (items) => [...new Map(items.map((item) =>
    [item.path, item])).values()];
  const finance = bookingDb.collection('financialRecords');
  const bookings = bookingDb.collection('bookings');
  const violations = bookingDb.collection('bookingViolations');
  const notifications = bookingDb.collection('notifications');
  const extensions = bookingDb.collection('bookingExtensionRequests');
  const periods = bookingDb.collection('membershipPeriods');
  const decisions = bookingDb.collection('membershipYearDecisions');

  const manualFinancialRecords = await readQuery(
    finance.where('memberId', '==', manualUid), 'financialRecords');
  const lineFinancialRecords = await readQuery(
    finance.where('memberId', '==', lineUid), 'financialRecords');
  const manualMembershipPeriods = await readQuery(
    periods.where('memberUid', '==', manualUid), 'membershipPeriods');
  const lineMembershipPeriods = await readQuery(
    periods.where('memberUid', '==', lineUid), 'membershipPeriods');
  const manualMembershipYearDecisions = await readQuery(
    decisions.where('memberUid', '==', manualUid),
    'membershipYearDecisions');
  const lineMembershipYearDecisions = await readQuery(
    decisions.where('memberUid', '==', lineUid),
    'membershipYearDecisions');
  const allBookings = await readQuery(bookings, 'bookings');
  const relatedBookings = allBookings.filter((item) =>
    bookingContainsMemberUid(item.data, manualUid) ||
    bookingContainsMemberUid(item.data, lineUid));
  const manualViolations = await readQuery(
    violations.where('memberUid', '==', manualUid), 'bookingViolations');
  const lineViolations = await readQuery(
    violations.where('memberUid', '==', lineUid), 'bookingViolations');
  const manualSummarySnap = await read(
    bookingDb.collection('bookingViolationSummaries').doc(manualUid));
  const lineSummarySnap = await read(
    bookingDb.collection('bookingViolationSummaries').doc(lineUid));
  const allMembers = await read(bookingDb.collection('members'));
  const coachMembers = allMembers.docs.filter((doc) => {
    const students = (doc.data() || {}).coachStudents || {};
    return Object.prototype.hasOwnProperty.call(students, manualUid) ||
      Object.prototype.hasOwnProperty.call(students, lineUid);
  }).map((doc) => ({
    path: `members/${doc.id}`,
    id: doc.id,
    data: doc.data() || {},
  }));
  const relatedNotifications = await readQuery(
    notifications.where('uid', '==', manualUid), 'notifications');
  const lineNotifications = await readQuery(
    notifications.where('uid', '==', lineUid), 'notifications');
  const manualExtensions = await readQuery(
    extensions.where('requesterUid', '==', manualUid),
    'bookingExtensionRequests');
  const lineExtensions = await readQuery(
    extensions.where('requesterUid', '==', lineUid),
    'bookingExtensionRequests');
  const identityLinkSnap = await read(memberIdentityLinkRef(lineUid));
  const identityClaimSnap = await read(
    bookingDb.collection('memberIdentityClaims').doc(manualUid));
  const memberIdentityLinks = await readQuery(
    bookingDb.collection('memberIdentityLinks')
      .where('memberUid', '==', manualUid),
    'memberIdentityLinks',
  );

  return {
    candidate: memberMergeDoc(
      `duplicateMemberCandidates/${candidateId}`, candidateSnap),
    lineMember: memberMergeDoc(`members/${lineUid}`, lineSnap),
    manualMember: memberMergeDoc(`members/${manualUid}`, manualSnap),
    manualFinancialRecords,
    lineFinancialRecords,
    manualMembershipPeriods,
    lineMembershipPeriods,
    manualMembershipYearDecisions,
    lineMembershipYearDecisions,
    bookings: union(relatedBookings),
    manualViolations,
    lineViolations,
    manualSummary: memberMergeDoc(
      `bookingViolationSummaries/${manualUid}`, manualSummarySnap),
    lineSummary: memberMergeDoc(
      `bookingViolationSummaries/${lineUid}`, lineSummarySnap),
    coachMembers,
    notifications: relatedNotifications,
    lineNotifications,
    extensionRequests: union(manualExtensions.concat(lineExtensions)),
    identityLink: memberMergeDoc(
      `memberIdentityLinks/${lineUid}`, identityLinkSnap),
    identityClaim: memberMergeDoc(
      `memberIdentityClaims/${manualUid}`, identityClaimSnap),
    memberIdentityLinks,
  };
}

function memberMergeChange(path, before, after) {
  return {
    path,
    beforeExists: before != null,
    before: before || null,
    after,
    beforeHash: memberMergeHash(before),
    afterHash: memberMergeHash(after),
  };
}

function buildMemberMergeChanges(state, assessment, actor, operationId, mergedAt) {
  const changes = [];
  const lineUid = state.lineMember.id;
  const manualUid = state.manualMember.id;
  const addChange = (item, after) => changes.push(
    memberMergeChange(item.path, item.data, after));
  const lineAfter = Object.assign({}, state.lineMember.data, {
    mergedFromUids: [...new Set(
      (state.lineMember.data.mergedFromUids || []).concat(manualUid),
    )],
    lastMergeOperationId: operationId,
    updatedAt: mergedAt,
  });
  if (assessment.effectiveMembership.membershipType) {
    lineAfter.membershipType = assessment.effectiveMembership.membershipType;
    lineAfter.membershipExpiry = assessment.effectiveMembership.membershipExpiry;
    lineAfter.expireDate = assessment.effectiveMembership.membershipExpiry;
  }
  addChange(state.lineMember, lineAfter);
  addChange(state.manualMember, Object.assign({}, state.manualMember.data, {
    status: 'merged',
    approved: false,
    mergedInto: lineUid,
    mergedAt,
    mergedByUid: actor.uid,
    mergedByName: actor.name,
    mergeOperationId: operationId,
    updatedAt: mergedAt,
  }));
  addChange(state.candidate, Object.assign({}, state.candidate.data, {
    status: 'merged',
    resolution: 'resolved',
    resolvedAt: mergedAt,
    resolvedByUid: actor.uid,
    resolvedByName: actor.name,
    mergeOperationId: operationId,
  }));
  state.manualFinancialRecords.forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberId: lineUid})));
  (state.manualMembershipPeriods || []).forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: lineUid})));
  (state.manualMembershipYearDecisions || []).forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: lineUid})));
  state.bookings.filter((item) =>
    bookingContainsMemberUid(item.data, manualUid)).forEach((item) =>
    addChange(item, replaceMemberUidInBooking(item.data, manualUid, lineUid)));
  state.manualViolations.forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: lineUid})));
  state.coachMembers.forEach((item) => {
    const students = Object.assign({}, item.data.coachStudents || {});
    if (!Object.prototype.hasOwnProperty.call(students, manualUid)) return;
    students[lineUid] = students[manualUid];
    delete students[manualUid];
    addChange(item, Object.assign({}, item.data, {coachStudents: students}));
  });
  state.notifications.forEach((item) => addChange(
    item, Object.assign({}, item.data, {uid: lineUid})));
  if (state.manualSummary) {
    const lineSummaryAfter = Object.assign({}, state.manualSummary.data, {
      memberUid: lineUid,
      mergeOperationId: operationId,
    });
    changes.push(memberMergeChange(
      `bookingViolationSummaries/${lineUid}`,
      state.lineSummary ? state.lineSummary.data : null,
      lineSummaryAfter,
    ));
    addChange(state.manualSummary, Object.assign({}, state.manualSummary.data, {
      status: 'merged',
      mergedInto: lineUid,
      mergedAt,
      mergeOperationId: operationId,
    }));
  }
  return changes;
}

function memberMergePreviewResponse(state, assessment, revalidationAssessment) {
  const line = state.lineMember.data;
  const manual = state.manualMember.data;
  return {
    canMerge: assessment.canMerge,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    previewHash: assessment.previewHash,
    lineMember: {
      uid: state.lineMember.id,
      realName: cleanString(line.realName || line.displayName, 100),
      displayName: cleanString(line.displayName, 100),
      memberSource: line.memberSource || 'line',
      status: line.status || '',
      approved: line.approved === true,
    },
    manualMember: {
      uid: state.manualMember.id,
      realName: cleanString(manual.realName || manual.displayName, 100),
      memberSource: manual.memberSource || 'manual',
      status: manual.status || '',
      approved: manual.approved === true,
      resultingStatus: 'merged',
      mergedInto: state.lineMember.id,
    },
    membershipType: assessment.effectiveMembership.membershipType || '',
    membershipExpiry: assessment.effectiveMembership.membershipExpiry || '',
    snapshotDifferences: assessment.snapshotDifferences || [],
    canRevalidate: Boolean(
      assessment.snapshotDifferences && assessment.snapshotDifferences.length &&
      revalidationAssessment && revalidationAssessment.canMerge),
    counts: assessment.counts,
    affectedDocuments: [
      state.lineMember.path,
      state.manualMember.path,
      state.candidate.path,
      ...state.manualFinancialRecords.map((item) => item.path),
      ...(state.manualMembershipPeriods || []).map((item) => item.path),
      ...(state.manualMembershipYearDecisions || [])
        .map((item) => item.path),
      ...state.bookings.filter((item) =>
        bookingContainsMemberUid(item.data, state.manualMember.id))
        .map((item) => item.path),
      ...state.manualViolations.map((item) => item.path),
      ...state.coachMembers.filter((item) =>
        Object.prototype.hasOwnProperty.call(
          item.data.coachStudents || {}, state.manualMember.id,
        )).map((item) => item.path),
      ...state.notifications.map((item) => item.path),
      ...(state.manualSummary ? [
        state.manualSummary.path,
        `bookingViolationSummaries/${state.lineMember.id}`,
      ] : []),
    ],
  };
}

function assessMemberIdentityBindingState(state) {
  const mergeAssessment = assessMemberMergeState(state);
  const blockers = mergeAssessment.blockers.slice();
  const lineUid = state.lineMember.id;
  const manualUid = state.manualMember.id;
  const lineStatus = state.lineMember.data.status || '';
  if (state.candidate.id !== duplicateMemberPairId(lineUid, manualUid)) {
    blockers.push('候選會員配對識別不一致');
  }
  if (['blocked', 'deleted', 'resigned', 'rejected'].includes(lineStatus)) {
    blockers.push('LINE 登入身分目前為安全封鎖狀態');
  }
  if (state.identityLink) {
    const link = state.identityLink.data || {};
    if (link.status === 'active' && link.memberUid !== manualUid) {
      blockers.push('此 LINE UID 已綁定其他永久會員');
    } else {
      blockers.push('此 LINE UID 已存在身分綁定紀錄');
    }
  }
  if (state.identityClaim) {
    const claim = state.identityClaim.data || {};
    if (claim.status === 'active' && claim.lineUid !== lineUid) {
      blockers.push('此永久會員已綁定其他 LINE UID');
    } else {
      blockers.push('此永久會員已存在身分認領紀錄');
    }
  }
  (state.memberIdentityLinks || []).forEach((item) => {
    if (item.id !== lineUid && (item.data || {}).status === 'active') {
      blockers.push('此永久會員已綁定其他 LINE UID');
    }
  });
  return Object.assign({}, mergeAssessment, {
    canBind: blockers.length === 0,
    blockers: [...new Set(blockers)],
    previewHash: memberMergeHash({
      basePreviewHash: mergeAssessment.previewHash,
      action: 'identity_bind',
      lineUid,
      manualUid,
    }),
  });
}

function buildMemberIdentityBindingChanges(
  state, assessment, actor, operationId, boundAt,
) {
  const changes = [];
  const lineUid = state.lineMember.id;
  const manualUid = state.manualMember.id;
  const addChange = (item, after) => changes.push(
    memberMergeChange(item.path, item.data, after));
  const manualAfter = Object.assign({}, state.manualMember.data, {
    lastIdentityOperationId: operationId,
    updatedAt: boundAt,
  });
  if (!manualAfter.membershipType &&
      assessment.effectiveMembership.membershipType) {
    manualAfter.membershipType = assessment.effectiveMembership.membershipType;
    manualAfter.membershipExpiry = assessment.effectiveMembership.membershipExpiry;
    manualAfter.expireDate = assessment.effectiveMembership.membershipExpiry;
  }
  addChange(state.manualMember, manualAfter);
  addChange(state.lineMember, Object.assign({}, state.lineMember.data, {
    status: 'merged',
    approved: false,
    mergedInto: manualUid,
    mergedAt: boundAt,
    mergedByUid: actor.uid,
    mergedByName: actor.name,
    mergeOperationId: operationId,
    updatedAt: boundAt,
  }));
  addChange(state.candidate, Object.assign({}, state.candidate.data, {
    status: 'linked',
    resolution: 'identity_bound',
    resolvedAt: boundAt,
    resolvedByUid: actor.uid,
    resolvedByName: actor.name,
    identityOperationId: operationId,
  }));
  changes.push(memberMergeChange(
    `memberIdentityLinks/${lineUid}`,
    state.identityLink ? state.identityLink.data : null,
    {
      lineUid,
      memberUid: manualUid,
      status: 'active',
      candidateId: state.candidate.id,
      operationId,
      createdAt: boundAt,
      createdByUid: actor.uid,
      createdByName: actor.name,
    },
  ));
  changes.push(memberMergeChange(
    `memberIdentityClaims/${manualUid}`,
    state.identityClaim ? state.identityClaim.data : null,
    {
      memberUid: manualUid,
      lineUid,
      status: 'active',
      operationId,
      createdAt: boundAt,
    },
  ));
  state.lineFinancialRecords.forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberId: manualUid})));
  (state.lineMembershipPeriods || []).forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: manualUid})));
  (state.lineMembershipYearDecisions || []).forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: manualUid})));
  state.bookings.filter((item) =>
    bookingContainsMemberUid(item.data, lineUid)).forEach((item) =>
    addChange(item, replaceMemberUidInBooking(item.data, lineUid, manualUid)));
  state.lineViolations.forEach((item) => addChange(
    item, Object.assign({}, item.data, {memberUid: manualUid})));
  state.coachMembers.forEach((item) => {
    const students = Object.assign({}, item.data.coachStudents || {});
    if (!Object.prototype.hasOwnProperty.call(students, lineUid)) return;
    students[manualUid] = students[lineUid];
    delete students[lineUid];
    addChange(item, Object.assign({}, item.data, {coachStudents: students}));
  });
  (state.lineNotifications || []).forEach((item) => addChange(
    item, Object.assign({}, item.data, {uid: manualUid})));
  if (state.lineSummary) {
    const manualSummaryAfter = Object.assign({}, state.lineSummary.data, {
      memberUid: manualUid,
      identityOperationId: operationId,
    });
    changes.push(memberMergeChange(
      `bookingViolationSummaries/${manualUid}`,
      state.manualSummary ? state.manualSummary.data : null,
      manualSummaryAfter,
    ));
    addChange(state.lineSummary, Object.assign({}, state.lineSummary.data, {
      status: 'merged',
      mergedInto: manualUid,
      mergedAt: boundAt,
      identityOperationId: operationId,
    }));
  }
  return changes;
}

function memberIdentityBindingPreviewResponse(state, assessment) {
  return {
    canBind: assessment.canBind,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    previewHash: assessment.previewHash,
    lineMember: {
      uid: state.lineMember.id,
      realName: memberDisplayName(state.lineMember.data, state.lineMember.id),
      status: state.lineMember.data.status || '',
    },
    permanentMember: {
      uid: state.manualMember.id,
      realName: memberDisplayName(state.manualMember.data, state.manualMember.id),
      status: state.manualMember.data.status || '',
    },
    counts: Object.assign({}, assessment.counts, {
      financialRecords: state.lineFinancialRecords.length,
      membershipPeriods: (state.lineMembershipPeriods || []).length,
      membershipYearDecisions:
        (state.lineMembershipYearDecisions || []).length,
      violations: state.lineViolations.length,
      notifications: (state.lineNotifications || []).length,
    }),
  };
}

async function getIdentityAdminActor(request) {
  const identity = await getAuthenticatedMember(request);
  if (!ADMIN_ROLES.has(identity.member.role || '')) {
    throw new HttpsError('permission-denied', '僅 Owner／Admin 可處理身分綁定');
  }
  return {
    uid: identity.memberUid,
    authUid: identity.authUid,
    name: memberDisplayName(identity.member, identity.memberUid),
  };
}

async function getOwnerMergeActor(request) {
  const identity = await getAuthenticatedMember(request);
  const actor = identity.member;
  if (actor.role !== 'owner') {
    throw new HttpsError('permission-denied', '僅 Owner 可執行會員合併');
  }
  return {
    uid: identity.memberUid,
    authUid: identity.authUid,
    name: memberDisplayName(actor, identity.memberUid),
  };
}

async function assertMemberMergeAuthIdentity(lineUid, manualUid) {
  const lineAuthUser = await admin.auth().getUser(lineUid).catch((error) => {
    if (error && error.code === 'auth/user-not-found') return null;
    throw error;
  });
  if (!lineAuthUser || lineAuthUser.uid !== lineUid) {
    throw new HttpsError(
      'failed-precondition', 'LINE 主帳號找不到對應的 Firebase Auth UID');
  }
  const manualAuthUser = await admin.auth().getUser(manualUid).catch((error) => {
    if (error && error.code === 'auth/user-not-found') return null;
    throw error;
  });
  if (manualAuthUser) {
    throw new HttpsError(
      'failed-precondition', '手動來源帳號已有 Firebase Auth 身分，禁止自動重新驗證');
  }
}

exports.previewMemberIdentityBinding = onCall(
  {region: 'asia-east1'}, async (request) => {
    await getIdentityAdminActor(request);
    const candidateId = cleanString(request.data && request.data.candidateId, 200);
    if (!candidateId) throw new HttpsError('invalid-argument', '缺少候選 ID');
    const state = await loadMemberMergeState((ref) => ref.get(), candidateId);
    await assertMemberMergeAuthIdentity(
      state.lineMember.id, state.manualMember.id);
    return memberIdentityBindingPreviewResponse(
      state, assessMemberIdentityBindingState(state));
  },
);

exports.executeMemberIdentityBinding = onCall(
  {region: 'asia-east1'}, async (request) => {
    const actor = await getIdentityAdminActor(request);
    const candidateId = cleanString(request.data && request.data.candidateId, 200);
    const previewHash = cleanString(request.data && request.data.previewHash, 100);
    if (!candidateId || !previewHash) {
      throw new HttpsError('invalid-argument', '缺少候選 ID 或預覽憑證');
    }
    const initialState = await loadMemberMergeState(
      (ref) => ref.get(), candidateId);
    await assertMemberMergeAuthIdentity(
      initialState.lineMember.id, initialState.manualMember.id);
    const operationRef = bookingDb.collection('memberIdentityOperations').doc();
    const auditRef = bookingDb.collection('memberIdentityAuditLogs').doc();
    const boundAt = admin.firestore.Timestamp.now();
    return bookingDb.runTransaction(async (transaction) => {
      const state = await loadMemberMergeState(
        (ref) => transaction.get(ref), candidateId);
      const assessment = assessMemberIdentityBindingState(state);
      if (!assessment.canBind) {
        throw new HttpsError(
          'failed-precondition', assessment.blockers.join('；'));
      }
      if (assessment.previewHash !== previewHash) {
        throw new HttpsError(
          'aborted', '資料已在預覽後變更，請重新預覽再執行綁定');
      }
      const changes = buildMemberIdentityBindingChanges(
        state, assessment, actor, operationRef.id, boundAt);
      if (changes.length > 100 ||
          Buffer.byteLength(JSON.stringify(canonicalMergeValue(changes))) >
            800000) {
        throw new HttpsError(
          'resource-exhausted', '受影響資料過多，請停止並由 Owner 人工確認');
      }
      changes.forEach((change) => {
        transaction.set(bookingDb.doc(change.path), change.after);
      });
      transaction.set(operationRef, {
        status: 'completed',
        action: 'identity_bind',
        candidateId,
        lineUid: state.lineMember.id,
        memberUid: state.manualMember.id,
        actorUid: actor.uid,
        actorAuthUid: actor.authUid,
        actorName: actor.name,
        createdAt: boundAt,
        previewHash,
        affectedDocuments: changes.map((change) => change.path),
        changes,
      });
      transaction.set(auditRef, {
        action: 'identity_bind',
        candidateId,
        operationId: operationRef.id,
        lineUid: state.lineMember.id,
        memberUid: state.manualMember.id,
        actorUid: actor.uid,
        actorAuthUid: actor.authUid,
        actorName: actor.name,
        timestamp: boundAt,
        source: 'executeMemberIdentityBinding',
      });
      return {
        ok: true,
        operationId: operationRef.id,
        memberUid: state.manualMember.id,
      };
    });
  },
);

exports.rejectMemberIdentityBinding = onCall(
  {region: 'asia-east1'}, async (request) => {
    const actor = await getIdentityAdminActor(request);
    const candidateId = cleanString(request.data && request.data.candidateId, 200);
    const reason = cleanString(request.data && request.data.reason, 500);
    if (!candidateId || !reason) {
      throw new HttpsError('invalid-argument', '候選 ID 與拒絕原因必填');
    }
    const candidateRef = bookingDb.collection('duplicateMemberCandidates')
      .doc(candidateId);
    const auditRef = bookingDb.collection('memberIdentityAuditLogs').doc();
    const rejectedAt = admin.firestore.Timestamp.now();
    return bookingDb.runTransaction(async (transaction) => {
      const candidateSnap = await transaction.get(candidateRef);
      if (!candidateSnap.exists) {
        throw new HttpsError('not-found', '找不到疑似重複會員候選');
      }
      const candidate = candidateSnap.data() || {};
      if (candidate.status !== 'pending') {
        throw new HttpsError('failed-precondition', '此候選已處理');
      }
      transaction.update(candidateRef, {
        status: 'rejected',
        resolution: 'not_same_person',
        rejectedAt,
        rejectedByUid: actor.uid,
        rejectedByName: actor.name,
        rejectReason: reason,
      });
      transaction.set(auditRef, {
        action: 'identity_reject',
        candidateId,
        lineUid: candidate.lineMemberUid || '',
        memberUid: candidate.manualMemberUid || '',
        actorUid: actor.uid,
        actorAuthUid: actor.authUid,
        actorName: actor.name,
        reason,
        timestamp: rejectedAt,
        source: 'rejectMemberIdentityBinding',
      });
      return {ok: true, candidateId};
    });
  },
);

exports.rollbackMemberIdentityBinding = onCall(
  {region: 'asia-east1'}, async (request) => {
    const actor = await getOwnerMergeActor(request);
    const operationId = cleanString(request.data && request.data.operationId, 200);
    const reason = cleanString(request.data && request.data.reason, 500);
    if (!operationId || !reason) {
      throw new HttpsError('invalid-argument', '操作 ID 與 rollback 原因必填');
    }
    const operationRef = bookingDb.collection('memberIdentityOperations')
      .doc(operationId);
    const auditRef = bookingDb.collection('memberIdentityAuditLogs').doc();
    const rolledBackAt = admin.firestore.Timestamp.now();
    return bookingDb.runTransaction(async (transaction) => {
      const operationSnap = await transaction.get(operationRef);
      if (!operationSnap.exists) throw new HttpsError('not-found', '找不到綁定操作');
      const operation = operationSnap.data() || {};
      if (operation.status !== 'completed' || !Array.isArray(operation.changes)) {
        throw new HttpsError('failed-precondition', '此綁定操作不可 rollback');
      }
      const currentSnaps = [];
      for (const change of operation.changes) {
        currentSnaps.push(await transaction.get(bookingDb.doc(change.path)));
      }
      currentSnaps.forEach((snap, index) => {
        const change = operation.changes[index];
        const current = snap.exists ? snap.data() || {} : null;
        if (memberMergeHash(current) !== change.afterHash) {
          throw new HttpsError(
            'aborted', `綁定後資料已變更，無法安全 rollback：${change.path}`);
        }
      });
      operation.changes.forEach((change) => {
        const ref = bookingDb.doc(change.path);
        if (change.beforeExists) transaction.set(ref, change.before);
        else transaction.delete(ref);
      });
      transaction.update(operationRef, {
        status: 'rolled_back',
        rolledBackAt,
        rolledBackByUid: actor.uid,
        rolledBackByName: actor.name,
        rollbackReason: reason,
      });
      transaction.set(auditRef, {
        action: 'identity_rollback',
        operationId,
        lineUid: operation.lineUid || '',
        memberUid: operation.memberUid || '',
        actorUid: actor.uid,
        actorName: actor.name,
        reason,
        timestamp: rolledBackAt,
        source: 'rollbackMemberIdentityBinding',
      });
      return {ok: true, operationId};
    });
  },
);

exports.previewMemberMerge = onCall({region: 'asia-east1'}, async (request) => {
  await getOwnerMergeActor(request);
  const candidateId = cleanString(request.data && request.data.candidateId, 200);
  if (!candidateId) throw new HttpsError('invalid-argument', '缺少候選 ID');
  const state = await loadMemberMergeState((ref) => ref.get(), candidateId);
  const assessment = assessMemberMergeState(state);
  const revalidationAssessment = assessMemberMergeState(
    state, {ignoreSnapshotMismatch: true});
  return memberMergePreviewResponse(
    state, assessment, revalidationAssessment);
});

exports.revalidateMemberMergeCandidate = onCall(
  {region: 'asia-east1'},
  async (request) => {
    const actor = await getOwnerMergeActor(request);
    const candidateId = cleanString(
      request.data && request.data.candidateId, 200);
    const confirmDeletedSource = Boolean(
      request.data && request.data.confirmDeletedSource);
    if (!candidateId) {
      throw new HttpsError('invalid-argument', '缺少候選 ID');
    }

    const candidateRef = bookingDb.collection('duplicateMemberCandidates')
      .doc(candidateId);
    const candidateSnap = await candidateRef.get();
    if (!candidateSnap.exists) {
      throw new HttpsError('not-found', '找不到疑似重複會員候選');
    }
    const candidate = candidateSnap.data() || {};
    const lineUid = cleanString(candidate.lineMemberUid, 200);
    const manualUid = cleanString(candidate.manualMemberUid, 200);
    if (!lineUid || !manualUid ||
        candidateId !== duplicateMemberPairId(lineUid, manualUid)) {
      throw new HttpsError('failed-precondition', '候選會員配對識別不一致');
    }
    await assertMemberMergeAuthIdentity(lineUid, manualUid);

    const revalidatedAt = admin.firestore.Timestamp.now();
    return bookingDb.runTransaction(async (transaction) => {
      const state = await loadMemberMergeState(
        (ref) => transaction.get(ref), candidateId);
      if (state.candidate.id !== duplicateMemberPairId(
        state.lineMember.id, state.manualMember.id)) {
        throw new HttpsError('failed-precondition', '候選會員配對識別不一致');
      }
      if (state.manualMember.data.status === 'deleted' &&
          !confirmDeletedSource) {
        throw new HttpsError(
          'failed-precondition',
          '手動來源會員目前為 deleted，需由 Owner 明確確認後才能重新驗證',
        );
      }
      const assessment = assessMemberMergeState(
        state, {ignoreSnapshotMismatch: true});
      if (!assessment.canMerge) {
        throw new HttpsError(
          'failed-precondition', assessment.blockers.join('；'));
      }
      const refreshedCandidate = buildRevalidatedMemberMergeCandidate(
        state.candidate.data,
        state.lineMember.id,
        state.lineMember.data,
        state.manualMember.id,
        state.manualMember.data,
        actor,
        revalidatedAt,
      );
      transaction.set(candidateRef, refreshedCandidate);
      const refreshedState = Object.assign({}, state, {
        candidate: Object.assign({}, state.candidate, {
          data: refreshedCandidate,
        }),
      });
      const refreshedAssessment = assessMemberMergeState(refreshedState);
      return memberMergePreviewResponse(
        refreshedState, refreshedAssessment,
        assessMemberMergeState(
          refreshedState, {ignoreSnapshotMismatch: true}),
      );
    });
  },
);

exports.executeMemberMerge = onCall({region: 'asia-east1'}, async (request) => {
  const actor = await getOwnerMergeActor(request);
  const candidateId = cleanString(request.data && request.data.candidateId, 200);
  const previewHash = cleanString(request.data && request.data.previewHash, 100);
  if (!candidateId || !previewHash) {
    throw new HttpsError('invalid-argument', '缺少候選 ID 或預覽憑證');
  }
  const operationRef = bookingDb.collection('memberMergeOperations').doc();
  const auditRef = bookingDb.collection('memberIdentityAuditLogs').doc();
  const mergedAt = admin.firestore.Timestamp.now();
  return bookingDb.runTransaction(async (transaction) => {
    const state = await loadMemberMergeState(
      (ref) => transaction.get(ref), candidateId);
    const assessment = assessMemberMergeState(state);
    if (!assessment.canMerge) {
      throw new HttpsError('failed-precondition', assessment.blockers.join('；'));
    }
    if (assessment.previewHash !== previewHash) {
      throw new HttpsError(
        'aborted', '資料已在預覽後變更，請重新預覽再執行合併');
    }
    const changes = buildMemberMergeChanges(
      state, assessment, actor, operationRef.id, mergedAt);
    if (changes.length > 100 ||
        Buffer.byteLength(JSON.stringify(canonicalMergeValue(changes))) > 800000) {
      throw new HttpsError(
        'resource-exhausted', '受影響資料過多，請停止並由 Owner 人工確認');
    }
    changes.forEach((change) => {
      transaction.set(bookingDb.doc(change.path), change.after);
    });
    transaction.set(operationRef, {
      status: 'completed',
      candidateId,
      sourceUid: state.manualMember.id,
      sourceName: memberDisplayName(
        state.manualMember.data, state.manualMember.id),
      targetUid: state.lineMember.id,
      targetName: memberDisplayName(state.lineMember.data, state.lineMember.id),
      actorUid: actor.uid,
      actorName: actor.name,
      createdAt: mergedAt,
      previewHash,
      affectedDocuments: changes.map((change) => change.path),
      counts: assessment.counts,
      before: {
        lineMember: state.lineMember.data,
        manualMember: state.manualMember.data,
        candidate: state.candidate.data,
      },
      after: {
        lineMember: changes.find((change) =>
          change.path === state.lineMember.path).after,
        manualMember: changes.find((change) =>
          change.path === state.manualMember.path).after,
        candidate: changes.find((change) =>
          change.path === state.candidate.path).after,
      },
      changes,
    });
    transaction.set(auditRef, {
      action: 'member_merge',
      candidateId,
      operationId: operationRef.id,
      lineUid: state.lineMember.id,
      memberUid: state.lineMember.id,
      sourceMemberUid: state.manualMember.id,
      actorUid: actor.uid,
      actorAuthUid: actor.authUid || actor.uid,
      actorName: actor.name,
      timestamp: mergedAt,
      source: 'executeMemberMerge',
    });
    return {ok: true, operationId: operationRef.id, counts: assessment.counts};
  });
});

exports.rollbackMemberMerge = onCall({region: 'asia-east1'}, async (request) => {
  const actor = await getOwnerMergeActor(request);
  const operationId = cleanString(request.data && request.data.operationId, 200);
  const reason = cleanString(request.data && request.data.reason, 500);
  if (!operationId || !reason) {
    throw new HttpsError('invalid-argument', '缺少合併操作 ID 或 rollback 原因');
  }
  const operationRef = bookingDb.collection('memberMergeOperations')
    .doc(operationId);
  const auditRef = bookingDb.collection('memberIdentityAuditLogs').doc();
  const rolledBackAt = admin.firestore.Timestamp.now();
  return bookingDb.runTransaction(async (transaction) => {
    const operationSnap = await transaction.get(operationRef);
    if (!operationSnap.exists) throw new HttpsError('not-found', '找不到合併操作');
    const operation = operationSnap.data() || {};
    if (operation.status !== 'completed' || !Array.isArray(operation.changes)) {
      throw new HttpsError('failed-precondition', '此合併操作不可 rollback');
    }
    const currentSnaps = [];
    for (const change of operation.changes) {
      currentSnaps.push(await transaction.get(bookingDb.doc(change.path)));
    }
    currentSnaps.forEach((snap, index) => {
      const change = operation.changes[index];
      const current = snap.exists ? snap.data() || {} : null;
      if (memberMergeHash(current) !== change.afterHash) {
        throw new HttpsError(
          'aborted', `合併後資料已變更，無法安全 rollback：${change.path}`);
      }
    });
    operation.changes.forEach((change) => {
      const ref = bookingDb.doc(change.path);
      if (change.beforeExists) transaction.set(ref, change.before);
      else transaction.delete(ref);
    });
    transaction.update(operationRef, {
      status: 'rolled_back',
      rolledBackAt,
      rolledBackByUid: actor.uid,
      rolledBackByName: actor.name,
      rollbackReason: reason,
    });
    transaction.set(auditRef, {
      action: 'member_merge_rollback',
      operationId,
      lineUid: operation.targetUid || '',
      memberUid: operation.targetUid || '',
      sourceMemberUid: operation.sourceUid || '',
      actorUid: actor.uid,
      actorAuthUid: actor.authUid || actor.uid,
      actorName: actor.name,
      reason,
      timestamp: rolledBackAt,
      source: 'rollbackMemberMerge',
    });
    return {ok: true, operationId};
  });
});

// ── detectDuplicateManualMember ──────────────────────────────────────
// LINE member 首次建立或 realName 實質變更時，唯讀比對既有手動會員。
// 僅建立待確認候選，不修改或合併任何 member 關聯資料。
exports.detectDuplicateManualMember = onDocumentWritten(
  {document: 'members/{memberId}', region: 'asia-east1'},
  async (event) => {
    const afterSnap = event.data && event.data.after;
    if (!afterSnap || !afterSnap.exists) return;
    const beforeSnap = event.data.before;
    const beforeExists = Boolean(beforeSnap && beforeSnap.exists);
    const before = beforeExists ? beforeSnap.data() || {} : null;
    const after = afterSnap.data() || {};
    if (!shouldDetectDuplicateMember(before, after, beforeExists)) return;

    const lineMemberUid = event.params.memberId;
    const identityLinkSnap = await memberIdentityLinkRef(lineMemberUid).get();
    if (identityLinkSnap.exists &&
        (identityLinkSnap.data() || {}).status === 'active') return;
    const normalisedName = normaliseMemberName(after.realName);
    const manualSnap = await bookingDb.collection('members')
      .where('memberSource', '==', 'manual')
      .get();
    const matches = manualSnap.docs.filter((doc) =>
      doc.id !== lineMemberUid &&
      normaliseMemberName((doc.data() || {}).realName) === normalisedName,
    );
    if (!matches.length) return;

    const detectionSource = beforeExists ? 'real_name_change' : 'member_create';
    await Promise.all(matches.map(async (manualDoc) => {
      const manual = manualDoc.data() || {};
      const pairId = duplicateMemberPairId(lineMemberUid, manualDoc.id);
      const candidateRef = bookingDb.collection('duplicateMemberCandidates')
        .doc(pairId);
      await bookingDb.runTransaction(async (transaction) => {
        const candidateSnap = await transaction.get(candidateRef);
        if (candidateSnap.exists) return;
        transaction.set(candidateRef, {
          lineMemberUid,
          manualMemberUid: manualDoc.id,
          matchedName: cleanString(after.realName, 50),
          matchReasons: ['exact_real_name'],
          status: 'pending',
          source: detectionSource,
          lineMember: duplicateMemberSnapshot(lineMemberUid, after, 'line'),
          manualMember: duplicateMemberSnapshot(manualDoc.id, manual, 'manual'),
          firstDetectedAt: SERVER_TS(),
        });
      });
    }));
  },
);

// ── Annual membership periods / renewals ────────────────────────────
// members/{uid} remains the permanent identity.  membershipPeriods is the
// immutable year/term history; members membership fields are only the active
// cache and are never advanced before the period start date.
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function addMembershipMonths(startDate, months) {
  const [year, month, day] = startDate.split('-').map(Number);
  const targetIndex = month - 1 + months;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0))
    .getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-` +
    `${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function membershipTypeForPlan(plan) {
  return plan === 'monthly' ? 'monthly' : 'annual';
}

function membershipPeriodStatus(startDate, expiryDate, today) {
  if (today < startDate) return 'scheduled';
  if (today > expiryDate) return 'expired';
  return 'active';
}

function membershipPeriodId(memberUid, spec) {
  const key = `${Number(spec.membershipYear)}|${memberUid}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

function buildMembershipRenewalSpec(input, today = taipeiDateString()) {
  const plan = cleanString(input.membershipPlan, 30);
  if (!MEMBERSHIP_PLANS.has(plan)) throw new Error('invalid_membership_plan');
  const paymentDate = cleanString(input.paymentDate, 10);
  if (!isIsoDate(paymentDate)) throw new Error('invalid_payment_date');
  const membershipType = membershipTypeForPlan(plan);
  const membershipYear = Number(input.membershipYear);
  const accountingYear = Number(input.accountingYear);
  if (!Number.isInteger(accountingYear) || accountingYear < 2025 ||
      accountingYear > 2036) throw new Error('invalid_accounting_year');
  let accountingDate;
  let membershipStartDate;
  let membershipExpiry;
  let periodMonths = null;
  if (membershipType === 'annual') {
    if (!Number.isInteger(membershipYear) || membershipYear < 2025 ||
        membershipYear > 2036) throw new Error('invalid_membership_year');
    accountingDate = `${accountingYear}-01-01`;
    membershipStartDate = `${membershipYear}-01-01`;
    membershipExpiry = `${membershipYear}-12-31`;
  } else {
    accountingDate = cleanString(input.accountingDate, 10);
    if (!isIsoDate(accountingDate)) throw new Error('invalid_accounting_date');
    if (Number(accountingDate.slice(0, 4)) !== accountingYear) {
      throw new Error('accounting_year_mismatch');
    }
    periodMonths = Number(input.periodMonths || 1);
    if (!Number.isInteger(periodMonths) || periodMonths < 1 ||
        periodMonths > 12) throw new Error('invalid_period_months');
    membershipStartDate = accountingDate;
    membershipExpiry = addMembershipMonths(accountingDate, periodMonths);
    if (membershipStartDate.startsWith('2026-') &&
        membershipExpiry > '2026-12-31') membershipExpiry = '2026-12-31';
  }
  return {
    membershipPlan: plan,
    membershipType,
    membershipYear: membershipType === 'annual' ? membershipYear :
      Number(accountingDate.slice(0, 4)),
    paymentDate,
    accountingDate,
    accountingYear,
    membershipStartDate,
    membershipExpiry,
    periodMonths,
    status: membershipPeriodStatus(
      membershipStartDate, membershipExpiry, today,
    ),
  };
}

function renewalOperationDocId(actorUid, requestId) {
  return crypto.createHash('sha256')
    .update(`${actorUid}\n${requestId}`, 'utf8').digest('hex');
}

function membershipPlanLabel(plan) {
  return ({
    annual_standard: '一般年費',
    annual_senior: '銀爸銀媽',
    annual_unclassified: '年費會員（待分類）',
    monthly: '月費',
  })[plan] || '';
}

function membershipPeriodOperationId(actorUid, action, targetKey, requestId) {
  return crypto.createHash('sha256')
    .update(`${actorUid}\n${action}\n${targetKey}\n${requestId}`, 'utf8')
    .digest('hex');
}

function assertMembershipManager(
  actorUid, actor, targetUid, target, allowSelf = false,
) {
  const actorRole = actor.role || '';
  const targetRole = target.role || 'member';
  if (!ADMIN_ROLES.has(actorRole)) {
    throw new HttpsError('permission-denied', '僅管理員可管理年度會員資格');
  }
  if (!allowSelf && actorUid === targetUid) {
    throw new HttpsError('failed-precondition', '不可操作自己的年度離會資格');
  }
  if ((!allowSelf || actorUid !== targetUid) &&
      (targetRole === 'owner' ||
       (actorRole === 'admin' && targetRole === 'admin'))) {
    throw new HttpsError('permission-denied', '無權限操作此會員');
  }
}

function membershipPeriodAuditData(
  operationId, action, periodId, period, actorUid, actorName,
  before, after, reason,
) {
  return {
    operationId,
    action,
    membershipPeriodId: periodId,
    memberUid: period.memberUid || '',
    membershipYear: Number(period.membershipYear) || null,
    actorUid,
    actorName,
    before,
    after,
    reason,
    createdAt: SERVER_TS(),
    source: 'web_callable',
  };
}

function membershipYearDecisionId(memberUid, membershipYear) {
  return `${membershipYear}_${memberUid}`;
}

function financialRecordMembershipYear(record) {
  const direct = Number(record.membershipYear || record.billingYear ||
    record.year);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const date = cleanString(record.accountingDate || record.date, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0, 4)) : 0;
}

async function mutateMembershipYearDecision(request, action) {
  const identity = await getAuthenticatedMember(request);
  const input = request.data || {};
  const memberUid = cleanString(input.memberUid, 128);
  const membershipYear = Number(input.membershipYear);
  const reason = cleanString(input.reason || input.note, 500);
  const requestId = cleanString(input.requestId, 128);
  if (!memberUid || !Number.isInteger(membershipYear) ||
      membershipYear < 2025 || membershipYear > 2100 || !requestId) {
    throw new HttpsError('invalid-argument', '會員、年度或請求識別碼不正確');
  }
  if (action === 'revoke' && !reason) {
    throw new HttpsError('invalid-argument', '撤銷原因必填');
  }
  const actorUid = identity.memberUid;
  const decisionId = membershipYearDecisionId(memberUid, membershipYear);
  const operationId = membershipPeriodOperationId(
    actorUid, `year_decision_${action}`, decisionId, requestId,
  );
  const actorRef = bookingDb.collection('members').doc(actorUid);
  const targetRef = bookingDb.collection('members').doc(memberUid);
  const decisionRef = bookingDb.collection('membershipYearDecisions')
    .doc(decisionId);
  const decisionsQuery = bookingDb.collection('membershipYearDecisions')
    .where('memberUid', '==', memberUid);
  const operationRef = bookingDb.collection('membershipPeriodOperations')
    .doc(operationId);
  const periodsQuery = bookingDb.collection('membershipPeriods')
    .where('memberUid', '==', memberUid);
  const financeQuery = bookingDb.collection('financialRecords')
    .where('memberId', '==', memberUid);
  return bookingDb.runTransaction(async (transaction) => {
    const [actorSnap, targetSnap, decisionSnap, decisionsSnap, operationSnap,
      periodsSnap, financeSnap] = await Promise.all([
      transaction.get(actorRef), transaction.get(targetRef),
      transaction.get(decisionRef), transaction.get(decisionsQuery),
      transaction.get(operationRef),
      transaction.get(periodsQuery), transaction.get(financeQuery),
    ]);
    if (operationSnap.exists) {
      const saved = operationSnap.data() || {};
      if (saved.action !== `year_decision_${action}` ||
          saved.memberUid !== memberUid ||
          Number(saved.membershipYear) !== membershipYear) {
        throw new HttpsError('already-exists', '請求識別碼已用於其他操作');
      }
      return {ok: true, idempotent: true, decisionId};
    }
    if (!actorSnap.exists || !targetSnap.exists) {
      throw new HttpsError('not-found', '找不到操作者或會員資料');
    }
    const actor = actorSnap.data() || {};
    const target = targetSnap.data() || {};
    assertMembershipManager(actorUid, actor, memberUid, target);
    const matchingDecisions = decisionsSnap.docs.filter((doc) =>
      Number((doc.data() || {}).membershipYear) === membershipYear);
    const resolvedDecisionSnap = decisionSnap.exists ? decisionSnap :
      matchingDecisions[0];
    if (matchingDecisions.filter((doc) =>
      (doc.data() || {}).status === 'not_joining').length > 1) {
      throw new HttpsError('failed-precondition', '此年度存在重複未加入決定，請人工確認');
    }
    const resolvedDecisionRef = resolvedDecisionSnap ?
      resolvedDecisionSnap.ref : decisionRef;
    const resolvedDecisionId = resolvedDecisionSnap ?
      resolvedDecisionSnap.id : decisionId;
    const currentDecision = resolvedDecisionSnap ?
      resolvedDecisionSnap.data() || {} : {};
    if (action === 'mark') {
      if (currentDecision.status === 'not_joining') {
        return {ok: true, idempotent: true, decisionId: resolvedDecisionId};
      }
      const hasPeriodConflict = periodsSnap.docs.some((doc) => {
        const period = doc.data() || {};
        return Number(period.membershipYear) === membershipYear &&
          !['revoked', 'cancelled'].includes(period.status || '');
      });
      const hasFinanceConflict = financeSnap.docs.some((doc) => {
        const record = doc.data() || {};
        return (record.status || 'active') !== 'void' &&
          ['annual', 'monthly'].includes(record.type || record.membershipType) &&
          financialRecordMembershipYear(record) === membershipYear;
      });
      if (hasPeriodConflict || hasFinanceConflict) {
        throw new HttpsError(
          'failed-precondition',
          '此年度已有會員資格或繳費紀錄，請先處理衝突',
        );
      }
      const hasPriorPeriod = periodsSnap.docs.some((doc) => {
        const period = doc.data() || {};
        return Number(period.membershipYear) < membershipYear &&
          !['revoked', 'cancelled'].includes(period.status || '');
      });
      if (!hasPriorPeriod) {
        throw new HttpsError('failed-precondition', '此會員不在指定年度待續會名單');
      }
    } else if (currentDecision.status !== 'not_joining') {
      throw new HttpsError('failed-precondition', '此年度沒有可撤銷的未加入決定');
    }
    const actorName = memberDisplayName(actor, actorUid);
    const memberName = memberDisplayName(target, memberUid);
    const before = decisionSnap.exists ? {
      status: currentDecision.status || '',
      note: currentDecision.note || '',
    } : null;
    const now = SERVER_TS();
    const after = action === 'mark' ? {
      status: 'not_joining', note: reason,
    } : {
      status: 'revoked', note: currentDecision.note || '',
    };
    if (action === 'mark') {
      transaction.set(resolvedDecisionRef, {
        memberUid,
        memberName,
        membershipYear,
        status: 'not_joining',
        note: reason,
        decidedAt: now,
        decidedByUid: actorUid,
        decidedByName: actorName,
        updatedAt: now,
      }, {merge: true});
    } else {
      transaction.update(resolvedDecisionRef, {
        status: 'revoked',
        revokedAt: now,
        revokedByUid: actorUid,
        revokedByName: actorName,
        revokeReason: reason,
        updatedAt: now,
      });
    }
    transaction.set(
      bookingDb.collection('membershipPeriodAuditLogs').doc(operationId),
      membershipPeriodAuditData(
        operationId,
        action === 'mark' ? 'membership_year_not_joining' :
          'membership_year_not_joining_revoked',
        resolvedDecisionId, {memberUid, membershipYear}, actorUid, actorName,
        before, after, reason,
      ),
    );
    transaction.set(operationRef, {
      action: `year_decision_${action}`,
      memberUid,
      membershipYear,
      decisionId: resolvedDecisionId,
      reason,
      actorUid,
      status: 'completed',
      createdAt: now,
    });
    return {ok: true, idempotent: false, decisionId: resolvedDecisionId};
  });
}

async function mutateMembershipYearStatus(request, action) {
  const identity = await getAuthenticatedMember(request);
  const input = request.data || {};
  const memberUid = cleanString(input.memberUid, 128);
  const membershipYear = Number(input.membershipYear);
  const reason = cleanString(input.reason, 500);
  const requestId = cleanString(input.requestId, 128);
  if (!memberUid || !Number.isInteger(membershipYear) ||
      !reason || !requestId) {
    throw new HttpsError('invalid-argument', '會員、年度、原因或請求識別碼不正確');
  }
  if (action === 'restore' && input.confirmRestore !== true) {
    throw new HttpsError('failed-precondition', '恢復年度資格需要管理員明確確認');
  }
  const actorUid = identity.memberUid;
  const targetKey = `${memberUid}|${membershipYear}`;
  const operationId = membershipPeriodOperationId(
    actorUid, action, targetKey, requestId,
  );
  const operationRef = bookingDb.collection('membershipPeriodOperations')
    .doc(operationId);
  const targetRef = bookingDb.collection('members').doc(memberUid);
  const periodsQuery = bookingDb.collection('membershipPeriods')
    .where('memberUid', '==', memberUid);
  return bookingDb.runTransaction(async (transaction) => {
    const [actorSnap, targetSnap, operationSnap, periodsSnap] =
      await Promise.all([
        transaction.get(bookingDb.collection('members').doc(actorUid)),
        transaction.get(targetRef), transaction.get(operationRef),
        transaction.get(periodsQuery),
      ]);
    if (operationSnap.exists) {
      const saved = operationSnap.data() || {};
      if (saved.action !== action || saved.memberUid !== memberUid ||
          Number(saved.membershipYear) !== membershipYear) {
        throw new HttpsError('already-exists', '請求識別碼已用於其他操作');
      }
      return {ok: true, idempotent: true, affectedCount: saved.affectedCount || 0};
    }
    if (!actorSnap.exists || !targetSnap.exists) {
      throw new HttpsError('not-found', '找不到操作者或會員資料');
    }
    const actor = actorSnap.data() || {};
    const target = targetSnap.data() || {};
    assertMembershipManager(actorUid, actor, memberUid, target);
    const periods = periodsSnap.docs.filter((doc) =>
      Number((doc.data() || {}).membershipYear) === membershipYear);
    if (!periods.length) {
      throw new HttpsError('failed-precondition', '此會員沒有指定年度資格紀錄');
    }
    const actorName = memberDisplayName(actor, actorUid);
    const now = SERVER_TS();
    const today = taipeiDateString();
    let affectedCount = 0;
    periods.forEach((periodSnap) => {
      const period = periodSnap.data() || {};
      if (action === 'resign') {
        if (period.status === 'resigned') return;
        if (!['active', 'scheduled'].includes(period.status || '')) return;
        const before = {
          status: period.status || '',
          membershipPlan: period.membershipPlan || '',
        };
        const after = {
          status: 'resigned',
          membershipPlan: period.membershipPlan || '',
        };
        transaction.update(periodSnap.ref, {
          status: 'resigned',
          statusBeforeResign: period.status || '',
          resignedAt: now,
          resignedByUid: actorUid,
          resignedByName: actorName,
          reason,
          resignReason: reason,
          updatedAt: now,
        });
        transaction.set(
          bookingDb.collection('membershipPeriodAuditLogs')
            .doc(`${operationId}_${periodSnap.id}`),
          membershipPeriodAuditData(
            operationId, 'membership_resigned', periodSnap.id, period,
            actorUid, actorName, before, after, reason,
          ),
        );
      } else {
        if (period.status !== 'resigned') return;
        const restoredStatus = membershipPeriodStatus(
          period.startDate, period.expiryDate, today,
        );
        const before = {
          status: period.status,
          membershipPlan: period.membershipPlan || '',
        };
        const after = {
          status: restoredStatus,
          membershipPlan: period.membershipPlan || '',
        };
        transaction.update(periodSnap.ref, {
          status: restoredStatus,
          restoredAt: now,
          restoredByUid: actorUid,
          restoredByName: actorName,
          restoreReason: reason,
          updatedAt: now,
        });
        transaction.set(
          bookingDb.collection('membershipPeriodAuditLogs')
            .doc(`${operationId}_${periodSnap.id}`),
          membershipPeriodAuditData(
            operationId, 'membership_restored', periodSnap.id, period,
            actorUid, actorName, before, after, reason,
          ),
        );
      }
      affectedCount += 1;
    });
    if (!affectedCount) {
      throw new HttpsError(
        'failed-precondition',
        action === 'resign' ? '此年度沒有可離會的有效資格' : '此年度沒有可恢復的離會資格',
      );
    }
    transaction.set(operationRef, {
      action,
      memberUid,
      membershipYear,
      affectedCount,
      reason,
      actorUid,
      createdAt: now,
      status: 'completed',
    });
    return {ok: true, idempotent: false, affectedCount};
  });
}

function membershipInputError(error) {
  const labels = {
    invalid_membership_plan: '會員分類不正確',
    invalid_payment_date: '實際收款日格式不正確',
    invalid_accounting_date: '財務歸屬日格式不正確',
    invalid_accounting_year: '財務歸屬年度不正確',
    accounting_year_mismatch: '財務歸屬日與歸屬年度不一致',
    invalid_membership_year: '會籍年度不正確',
    invalid_period_months: '月費期數不正確',
  };
  return labels[error && error.message] || '續會資料格式不正確';
}

exports.createMembershipRenewal = onCall(
  {region: 'asia-east1'}, async (request) => {
    const identity = await getAuthenticatedMember(request);
    const input = request.data || {};
    const memberUid = cleanString(input.memberUid, 128);
    const requestId = cleanString(input.idempotencyKey, 128);
    const amount = Number(input.amount);
    if (!memberUid || !requestId || !Number.isInteger(amount) || amount <= 0) {
      throw new HttpsError('invalid-argument', '會員、金額或請求識別碼不正確');
    }
    let spec;
    try {
      spec = buildMembershipRenewalSpec(input);
    } catch (error) {
      throw new HttpsError('invalid-argument', membershipInputError(error));
    }
    const actorUid = identity.memberUid;
    const operationId = renewalOperationDocId(actorUid, requestId);
    const operationRef = bookingDb.collection('membershipRenewalOperations')
      .doc(operationId);
    const memberRef = bookingDb.collection('members').doc(memberUid);
    const periodId = membershipPeriodId(memberUid, spec);
    const periodRef = bookingDb.collection('membershipPeriods').doc(periodId);
    const decisionsQuery = bookingDb.collection('membershipYearDecisions')
      .where('memberUid', '==', memberUid);
    const financeRef = bookingDb.collection('financialRecords')
      .doc(`renewal_${operationId}`);

    return bookingDb.runTransaction(async (transaction) => {
      const actorRef = bookingDb.collection('members').doc(actorUid);
      const [actorSnap, memberSnap, operationSnap, periodSnap, decisionsSnap,
        financeSnap, memberFinanceSnap] = await Promise.all([
        transaction.get(actorRef),
        transaction.get(memberRef),
        transaction.get(operationRef),
        transaction.get(periodRef),
        transaction.get(decisionsQuery),
        transaction.get(financeRef),
        transaction.get(bookingDb.collection('financialRecords')
          .where('memberId', '==', memberUid)),
      ]);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (!actorSnap.exists || !ADMIN_ROLES.has(actor.role || '')) {
        throw new HttpsError('permission-denied', '僅管理員可建立會員續會');
      }
      if (operationSnap.exists) {
        const saved = operationSnap.data() || {};
        if (saved.memberUid !== memberUid) {
          throw new HttpsError('already-exists', '此請求識別碼已用於其他會員');
        }
        return {
          ok: true, idempotent: true, operationId,
          financialRecordId: saved.financialRecordId || financeRef.id,
          membershipPeriodId: saved.membershipPeriodId || periodId,
        };
      }
      if (!memberSnap.exists) {
        throw new HttpsError('not-found', '找不到會員資料');
      }
      if (decisionsSnap.docs.some((doc) => {
        const decision = doc.data() || {};
        return Number(decision.membershipYear) === spec.membershipYear &&
          decision.status === 'not_joining';
      })) {
        throw new HttpsError(
          'failed-precondition', '請先撤銷此年度「今年不加入」再建立繳費資格',
        );
      }
      const member = memberSnap.data() || {};
      if (member.status === 'merged' || member.mergedInto ||
          member.status === 'blocked') {
        throw new HttpsError('failed-precondition', '此會員狀態不可續會');
      }
      const duplicates = memberFinanceSnap.docs.some((doc) => {
        const record = doc.data() || {};
        if ((record.status || 'active') === 'void') return false;
        if (record.type !== spec.membershipType) return false;
        if (spec.membershipType === 'annual') {
          return Number(record.membershipYear) === spec.membershipYear;
        }
        return Number(record.billingYear) ===
            Number(spec.accountingDate.slice(0, 4)) &&
          Number(record.billingMonth) ===
            Number(spec.accountingDate.slice(5, 7));
      });
      if (duplicates || financeSnap.exists) {
        throw new HttpsError('already-exists', '此會員該年度／帳期已有繳費資格');
      }
      const existingPeriod = periodSnap.exists ? periodSnap.data() || {} : null;
      if (existingPeriod) {
        if (existingPeriod.memberUid !== memberUid ||
            Number(existingPeriod.membershipYear) !== spec.membershipYear ||
            existingPeriod.membershipType !== spec.membershipType ||
            ['revoked', 'cancelled', 'resigned'].includes(existingPeriod.status || '')) {
          throw new HttpsError('failed-precondition', '同年度會員資格存在衝突，請人工確認');
        }
        if (spec.membershipType === 'annual') {
          throw new HttpsError('already-exists', '此會員該年度已有年費資格');
        }
      }
      const actorName = memberDisplayName(actor, actorUid);
      const memberName = memberDisplayName(member, memberUid);
      const now = SERVER_TS();
      const finance = {
        type: spec.membershipType,
        memberId: memberUid,
        memberDisplayName: cleanString(member.displayName, 100),
        memberRealName: cleanString(member.realName, 100),
        memberNameSnapshot: memberName,
        date: spec.paymentDate,
        accountingDate: spec.accountingDate,
        year: spec.accountingYear,
        amount,
        note: cleanString(input.note, 300),
        membershipType: spec.membershipType,
        membershipPlan: spec.membershipPlan,
        membershipYear: spec.membershipYear,
        membershipStartDate: spec.membershipStartDate,
        membershipExpiry: spec.membershipExpiry.replace(/-/g, '/'),
        periodMonths: spec.periodMonths,
        billingYear: spec.membershipType === 'monthly' ?
          Number(spec.accountingDate.slice(0, 4)) : null,
        billingMonth: spec.membershipType === 'monthly' ?
          Number(spec.accountingDate.slice(5, 7)) : null,
        renewalOperationId: operationId,
        createdByUid: actorUid,
        createdByName: actorName,
        createdAt: now,
        updatedAt: null,
        status: 'active',
      };
      const combinedStartDate = existingPeriod && existingPeriod.startDate <
        spec.membershipStartDate ? existingPeriod.startDate : spec.membershipStartDate;
      const combinedExpiryDate = existingPeriod && existingPeriod.expiryDate >
        spec.membershipExpiry ? existingPeriod.expiryDate : spec.membershipExpiry;
      const period = {
        memberUid,
        memberName,
        membershipYear: spec.membershipYear,
        membershipType: spec.membershipType,
        membershipPlan: spec.membershipPlan,
        membershipPlanLabel: membershipPlanLabel(spec.membershipPlan),
        startDate: combinedStartDate,
        expiryDate: combinedExpiryDate,
        status: membershipPeriodStatus(
          combinedStartDate, combinedExpiryDate, taipeiDateString(),
        ),
        financialRecordId: existingPeriod && existingPeriod.financialRecordId ||
          financeRef.id,
        financialRecordIds: admin.firestore.FieldValue.arrayUnion(financeRef.id),
        renewalOperationId: operationId,
        renewalOperationIds: admin.firestore.FieldValue.arrayUnion(operationId),
        updatedAt: now,
        updatedByUid: actorUid,
        updatedByName: actorName,
      };
      if (!existingPeriod) {
        Object.assign(period, {
          createdAt: now,
          createdByUid: actorUid,
          createdByName: actorName,
        });
      }
      transaction.set(financeRef, finance);
      transaction.set(periodRef, period, {merge: true});
      transaction.set(
        bookingDb.collection('membershipPeriodAuditLogs')
          .doc(`renewal_${operationId}`),
        membershipPeriodAuditData(
          operationId, existingPeriod ? 'membership_period_extended' :
            'membership_period_created', periodId,
          existingPeriod || {memberUid, membershipYear: spec.membershipYear},
          actorUid, actorName,
          existingPeriod ? {
            startDate: existingPeriod.startDate || '',
            expiryDate: existingPeriod.expiryDate || '',
            financialRecordIds: existingPeriod.financialRecordIds ||
              (existingPeriod.financialRecordId ?
                [existingPeriod.financialRecordId] : []),
          } : null,
          {
            startDate: combinedStartDate,
            expiryDate: combinedExpiryDate,
            addedFinancialRecordId: financeRef.id,
          },
          '會員續會繳費',
        ),
      );
      transaction.set(operationRef, {
        status: 'completed',
        memberUid,
        financialRecordId: financeRef.id,
        membershipPeriodId: periodId,
        requestId,
        createdAt: now,
        createdByUid: actorUid,
      });
      const memberUpdate = {};
      // A future annual period must not become the active member cache early.
      if (period.status === 'active') {
        Object.assign(memberUpdate, {
          membershipType: spec.membershipType,
          membershipPlan: spec.membershipPlan,
          membershipExpiry: combinedExpiryDate.replace(/-/g, '/'),
          expireDate: combinedExpiryDate.replace(/-/g, '/'),
          updatedAt: now,
        });
      } else if (period.status === 'scheduled') {
        Object.assign(memberUpdate, {
          membershipRenewalYears: admin.firestore.FieldValue.arrayUnion(
            spec.membershipYear,
          ),
          nextMembershipPeriodId: periodId,
          nextMembershipStartDate: spec.membershipStartDate,
          nextMembershipExpiry: combinedExpiryDate.replace(/-/g, '/'),
          renewedAt: now,
          updatedAt: now,
        });
      }
      if (Object.keys(memberUpdate).length) {
        transaction.update(memberRef, memberUpdate);
      }
      return {
        ok: true, idempotent: false, operationId,
        financialRecordId: financeRef.id,
        membershipPeriodId: periodId,
        periodStatus: period.status,
      };
    });
  },
);

exports.resignMembershipYear = onCall(
  {region: 'asia-east1'}, (request) =>
    mutateMembershipYearStatus(request, 'resign'),
);

exports.restoreMembershipYear = onCall(
  {region: 'asia-east1'}, (request) =>
    mutateMembershipYearStatus(request, 'restore'),
);

exports.markMembershipYearNotJoining = onCall(
  {region: 'asia-east1'}, (request) =>
    mutateMembershipYearDecision(request, 'mark'),
);

exports.revokeMembershipYearNotJoining = onCall(
  {region: 'asia-east1'}, (request) =>
    mutateMembershipYearDecision(request, 'revoke'),
);

exports.updateMembershipPeriodClassification = onCall(
  {region: 'asia-east1'}, async (request) => {
    const identity = await getAuthenticatedMember(request);
    const input = request.data || {};
    const periodId = cleanString(input.membershipPeriodId, 128);
    const membershipPlan = cleanString(input.membershipPlan, 30);
    const reason = cleanString(input.reason, 500);
    const requestId = cleanString(input.requestId, 128);
    if (!periodId || !MEMBERSHIP_PLANS.has(membershipPlan) ||
        !reason || !requestId) {
      throw new HttpsError('invalid-argument', '年度資格、分類、原因或請求識別碼不正確');
    }
    const actorUid = identity.memberUid;
    const operationId = membershipPeriodOperationId(
      actorUid, 'classification', periodId, requestId,
    );
    const periodRef = bookingDb.collection('membershipPeriods').doc(periodId);
    const operationRef = bookingDb.collection('membershipPeriodOperations')
      .doc(operationId);
    return bookingDb.runTransaction(async (transaction) => {
      const [actorSnap, periodSnap, operationSnap] = await Promise.all([
        transaction.get(bookingDb.collection('members').doc(actorUid)),
        transaction.get(periodRef), transaction.get(operationRef),
      ]);
      if (operationSnap.exists) {
        const saved = operationSnap.data() || {};
        if (saved.action !== 'classification' ||
            saved.membershipPeriodId !== periodId) {
          throw new HttpsError('already-exists', '請求識別碼已用於其他操作');
        }
        return {ok: true, idempotent: true};
      }
      if (!actorSnap.exists || !periodSnap.exists) {
        throw new HttpsError('not-found', '找不到操作者或年度資格');
      }
      const actor = actorSnap.data() || {};
      const period = periodSnap.data() || {};
      const targetRef = bookingDb.collection('members').doc(period.memberUid || '');
      const targetSnap = await transaction.get(targetRef);
      if (!targetSnap.exists) throw new HttpsError('not-found', '找不到會員資料');
      assertMembershipManager(
        actorUid, actor, period.memberUid, targetSnap.data() || {}, true,
      );
      if (membershipTypeForPlan(membershipPlan) !== period.membershipType) {
        throw new HttpsError('failed-precondition', '年度分類不可改變原年費／月費類型');
      }
      if (period.membershipPlan === membershipPlan) {
        return {ok: true, idempotent: true, unchanged: true};
      }
      const actorName = memberDisplayName(actor, actorUid);
      const before = {
        membershipPlan: period.membershipPlan || '',
        membershipPlanLabel: period.membershipPlanLabel || '',
        membershipType: period.membershipType || '',
      };
      const after = {
        membershipPlan,
        membershipPlanLabel: membershipPlanLabel(membershipPlan),
        membershipType: period.membershipType || '',
      };
      transaction.update(periodRef, Object.assign({}, after, {
        updatedAt: SERVER_TS(),
        updatedByUid: actorUid,
        updatedByName: actorName,
      }));
      transaction.set(
        bookingDb.collection('membershipPeriodAuditLogs').doc(operationId),
        membershipPeriodAuditData(
          operationId, 'membership_classification_changed', periodId,
          period, actorUid, actorName, before, after, reason,
        ),
      );
      transaction.set(operationRef, {
        action: 'classification',
        membershipPeriodId: periodId,
        memberUid: period.memberUid,
        membershipYear: period.membershipYear,
        actorUid,
        reason,
        status: 'completed',
        createdAt: SERVER_TS(),
      });
      return {ok: true, idempotent: false};
    });
  },
);

exports.backfillMembershipPeriod = onCall(
  {region: 'asia-east1'}, async (request) => {
    const identity = await getAuthenticatedMember(request);
    const input = request.data || {};
    const recordId = cleanString(input.financialRecordId, 128);
    const plan = cleanString(input.membershipPlan, 30);
    if (!recordId || !BACKFILL_MEMBERSHIP_PLANS.has(plan)) {
      throw new HttpsError('invalid-argument', '補登資料不正確');
    }
    const actorUid = identity.memberUid;
    const recordRef = bookingDb.collection('financialRecords').doc(recordId);
    return bookingDb.runTransaction(async (transaction) => {
      const actorRef = bookingDb.collection('members').doc(actorUid);
      const [actorSnap, recordSnap] = await Promise.all([
        transaction.get(actorRef), transaction.get(recordRef),
      ]);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (!actorSnap.exists || !ADMIN_ROLES.has(actor.role || '')) {
        throw new HttpsError('permission-denied', '僅管理員可補登年度分類');
      }
      if (!recordSnap.exists) throw new HttpsError('not-found', '找不到財務紀錄');
      const record = recordSnap.data() || {};
      if ((record.status || 'active') !== 'active' ||
          !['annual', 'monthly'].includes(record.type)) {
        throw new HttpsError('failed-precondition', '僅可補登有效年費／月費紀錄');
      }
      const year = Number(record.membershipYear || record.billingYear ||
        String(record.date || '').slice(0, 4));
      if (![2026, 2027].includes(year)) {
        throw new HttpsError('failed-precondition', '本功能僅供補登 2026／2027 年資格');
      }
      const memberUid = cleanString(record.memberId, 128);
      if (!memberUid) {
        throw new HttpsError('failed-precondition', '原財務紀錄缺少 memberId，請先人工核對');
      }
      const memberRef = bookingDb.collection('members').doc(memberUid);
      const financeQuery = bookingDb.collection('financialRecords')
        .where('memberId', '==', memberUid);
      const [memberSnap, financeSnap] = await Promise.all([
        transaction.get(memberRef), transaction.get(financeQuery),
      ]);
      if (!memberSnap.exists) {
        throw new HttpsError('failed-precondition', '找不到永久會員身分');
      }
      const member = memberSnap.data() || {};
      assertMembershipManager(actorUid, actor, memberUid, member, true);
      const officialMembershipType = cleanString(member.membershipType, 20);
      if (!['annual', 'monthly'].includes(officialMembershipType)) {
        throw new HttpsError('failed-precondition', '永久會員資料缺少正式會員類型');
      }
      if (membershipTypeForPlan(plan) !== officialMembershipType) {
        throw new HttpsError('failed-precondition', '補登分類與正式會員類型不一致');
      }
      const sourceRecords = financeSnap.docs.map((doc) => ({
        id: doc.id, data: doc.data() || {},
      })).filter((item) => {
        const itemRecord = item.data;
        return (itemRecord.status || 'active') === 'active' &&
          ['annual', 'monthly'].includes(itemRecord.type) &&
          financialRecordMembershipYear(itemRecord) === year;
      });
      if (!sourceRecords.length) {
        throw new HttpsError('failed-precondition', '找不到可佐證的年度繳費紀錄');
      }
      const sourceTypes = new Set(sourceRecords.map((item) => item.data.type));
      const fingerprints = new Set();
      const suspectedDuplicate = sourceRecords.some((item) => {
        const itemRecord = item.data;
        const fingerprint = [itemRecord.type,
          cleanString(itemRecord.date, 10),
          cleanString(itemRecord.accountingDate, 10),
          Number(itemRecord.amount || 0),
          normaliseExpiryDate(itemRecord.membershipExpiry || ''),
          Number(itemRecord.periodMonths || 0)].join('|');
        if (fingerprints.has(fingerprint)) return true;
        fingerprints.add(fingerprint);
        return false;
      });
      const sourcePayments = sourceRecords.map((item) => ({
        financialRecordId: item.id,
        type: item.data.type,
        paymentDate: cleanString(item.data.date, 10),
        accountingDate: cleanString(item.data.accountingDate, 10),
        amount: Number(item.data.amount || 0),
      })).sort((first, second) =>
        first.financialRecordId.localeCompare(second.financialRecordId));
      const qualificationRecords = sourceRecords.filter((item) =>
        item.data.type === officialMembershipType);
      if (!qualificationRecords.length) {
        throw new HttpsError('failed-precondition', '年度繳費與正式會員類型無法對應');
      }
      const starts = qualificationRecords.map((item) =>
        officialMembershipType === 'annual' ?
        `${year}-01-01` : cleanString(
          item.data.accountingDate || item.data.date, 10,
        )).filter(isIsoDate).sort();
      const expiries = qualificationRecords.map((item) =>
        normaliseExpiryDate(item.data.membershipExpiry || ''),
      ).filter(isIsoDate).sort();
      if (!starts.length || !expiries.length) {
        throw new HttpsError('failed-precondition', '原紀錄缺少有效資格日期');
      }
      const periodId = membershipPeriodId(memberUid, {membershipYear: year});
      const periodRef = bookingDb.collection('membershipPeriods').doc(periodId);
      const operationId = crypto.createHash('sha256')
        .update(`membership_period_backfill|${periodId}`, 'utf8').digest('hex');
      const operationRef = bookingDb.collection('membershipPeriodOperations')
        .doc(operationId);
      const [periodSnap, operationSnap] = await Promise.all([
        transaction.get(periodRef), transaction.get(operationRef),
      ]);
      if (periodSnap.exists) {
        const saved = periodSnap.data() || {};
        const savedIds = (saved.financialRecordIds ||
          (saved.financialRecordId ? [saved.financialRecordId] : [])).slice().sort();
        const sourceIds = sourcePayments.map((item) => item.financialRecordId);
        if (saved.memberUid !== memberUid ||
            Number(saved.membershipYear) !== year ||
            saved.membershipPlan !== plan ||
            JSON.stringify(savedIds) !== JSON.stringify(sourceIds)) {
          throw new HttpsError('already-exists', '此會員年度資格與預演資料不一致');
        }
        return {ok: true, idempotent: true, membershipPeriodId: periodRef.id};
      }
      if (operationSnap.exists) {
        throw new HttpsError('failed-precondition', '遷移操作已存在但資格文件不存在，請人工確認');
      }
      const startDate = starts[0];
      const expiryDate = expiries[expiries.length - 1];
      const period = {
        memberUid,
        memberName: cleanString(record.memberNameSnapshot ||
          record.memberRealName || record.memberDisplayName, 100),
        membershipYear: year,
        membershipType: officialMembershipType,
        membershipPlan: plan,
        membershipPlanLabel: membershipPlanLabel(plan),
        startDate,
        expiryDate,
        status: member.status === 'deleted' ? 'resigned' :
          membershipPeriodStatus(startDate, expiryDate, taipeiDateString()),
        financialRecordId: sourcePayments[0].financialRecordId,
        financialRecordIds: sourcePayments.map((item) =>
          item.financialRecordId),
        sourcePayments,
        evidenceFlags: {
          mixedAnnualMonthly: sourceTypes.size > 1,
          suspectedDuplicate,
        },
        historicalSnapshotSource: 'members',
        source: 'membership_period_backfill',
        migrationOperationId: operationId,
        createdAt: SERVER_TS(),
        createdByUid: actorUid,
        createdByName: memberDisplayName(actor, actorUid),
      };
      transaction.create(periodRef, period);
      transaction.create(operationRef, {
        action: 'membership_period_backfill',
        status: 'completed',
        rollbackAvailable: true,
        membershipPeriodId: periodId,
        memberUid,
        membershipYear: year,
        financialRecordIds: period.financialRecordIds,
        evidenceFlags: period.evidenceFlags,
        before: null,
        after: {
          membershipPlan: plan,
          startDate,
          expiryDate,
          financialRecordIds: period.financialRecordIds,
          evidenceFlags: period.evidenceFlags,
        },
        actorUid,
        createdAt: SERVER_TS(),
      });
      transaction.create(
        bookingDb.collection('membershipPeriodAuditLogs')
          .doc(operationId),
        membershipPeriodAuditData(
          operationId, 'membership_period_backfilled', periodId, period,
          actorUid, memberDisplayName(actor, actorUid), null,
          {membershipPlan: plan, startDate, expiryDate,
            financialRecordIds: period.financialRecordIds,
            evidenceFlags: period.evidenceFlags},
          `${year} 年度資格補建`,
        ),
      );
      return {ok: true, idempotent: false, membershipPeriodId: periodRef.id};
    });
  },
);

exports.rollbackMembershipPeriodBackfill = onCall(
  {region: 'asia-east1'}, async (request) => {
    const identity = await getAuthenticatedMember(request);
    const operationId = cleanString((request.data || {}).operationId, 128);
    const reason = cleanString((request.data || {}).reason, 500);
    if (!operationId || !reason) {
      throw new HttpsError('invalid-argument', '遷移操作與回復原因必填');
    }
    const actorUid = identity.memberUid;
    const operationRef = bookingDb.collection('membershipPeriodOperations')
      .doc(operationId);
    return bookingDb.runTransaction(async (transaction) => {
      const [actorSnap, operationSnap] = await Promise.all([
        transaction.get(bookingDb.collection('members').doc(actorUid)),
        transaction.get(operationRef),
      ]);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (!actorSnap.exists || actor.role !== 'owner') {
        throw new HttpsError('permission-denied', '僅 Owner 可回復年度資格遷移');
      }
      if (!operationSnap.exists) throw new HttpsError('not-found', '找不到遷移操作');
      const operation = operationSnap.data() || {};
      if (operation.action !== 'membership_period_backfill') {
        throw new HttpsError('failed-precondition', '此操作不可使用本回復流程');
      }
      if (operation.status === 'rolled_back') {
        return {ok: true, idempotent: true};
      }
      if (operation.status !== 'completed' || !operation.rollbackAvailable) {
        throw new HttpsError('failed-precondition', '此遷移目前不可回復');
      }
      const periodRef = bookingDb.collection('membershipPeriods')
        .doc(operation.membershipPeriodId || '');
      const periodSnap = await transaction.get(periodRef);
      if (!periodSnap.exists ||
          (periodSnap.data() || {}).migrationOperationId !== operationId) {
        throw new HttpsError('failed-precondition', '年度資格已變更，停止自動回復');
      }
      const period = periodSnap.data() || {};
      const actorName = memberDisplayName(actor, actorUid);
      transaction.delete(periodRef);
      transaction.update(operationRef, {
        status: 'rolled_back',
        rollbackAvailable: false,
        rolledBackAt: SERVER_TS(),
        rolledBackByUid: actorUid,
        rolledBackByName: actorName,
        rollbackReason: reason,
      });
      transaction.create(
        bookingDb.collection('membershipPeriodAuditLogs')
          .doc(`rollback_${operationId}`),
        membershipPeriodAuditData(
          operationId, 'membership_period_backfill_rolled_back',
          periodSnap.id, period, actorUid, actorName,
          period, null, reason,
        ),
      );
      return {ok: true, idempotent: false};
    });
  },
);

// ── createManualMember ────────────────────────────────────────────────
// 管理員手動建立會員（無 LINE 帳號者）。
// 由 Admin SDK 寫入 Firestore（bypass rules），
// 呼叫者身份驗證：request.auth.uid → members/{uid}.role 必須為 owner/admin。
// docId = Firestore auto-ID，uid 欄位 = docId（與 LINE 會員結構一致）。
exports.createManualMember = onCall({ region: 'asia-east1' }, async (request) => {
  // ① 呼叫者 role 以身分對照後的永久 member doc 為準。
  const db = admin.firestore();
  const identity = await getAuthenticatedMember(request);
  const callerRole = identity.member.role || '';
  if (callerRole !== 'owner' && callerRole !== 'admin') {
    throw new HttpsError('permission-denied',
      '僅 owner/admin 可手動建立會員（目前身份 role: ' + (callerRole || 'unknown') + '）');
  }

  // ③ 輸入驗證（role 僅允許 member/coach，其餘欄位白名單）
  const d = request.data || {};
  const realName = (typeof d.realName === 'string') ? d.realName.trim() : '';
  if (!realName || realName.length > 50) {
    throw new HttpsError('invalid-argument', 'realName 必填，50 字以內');
  }
  const displayName = (typeof d.displayName === 'string' && d.displayName.trim())
    ? d.displayName.trim().slice(0, 50) : realName;
  const role = (d.role === 'coach') ? 'coach' : 'member';
  const membershipType = ['annual', 'monthly'].includes(d.membershipType) ? d.membershipType : '';
  const ntrp = (typeof d.ntrp === 'string') ? d.ntrp.slice(0, 10) : '';
  const preferredPosition = (typeof d.preferredPosition === 'string') ? d.preferredPosition.slice(0, 10) : '';

  // ④ 單次寫入（uid = docId，避免 add 後再 update）
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('members').doc();
  await ref.set({
    uid:               ref.id,
    realName:          realName,
    displayName:       displayName,
    photoURL:          '',
    role:              role,
    membershipType:    membershipType,
    status:            'approved',
    memberSource:      'manual',
    approved:          true,
    ntrp:              ntrp,
    preferredPosition: preferredPosition,
    createdAt:         now,
    updatedAt:         now,
    approvedAt:        now,
    approvedBy:        identity.memberUid,
    lastLoginAt:       null,
  });

  console.info('[createManualMember]', realName, '| role:', role, '| by:', identity.memberUid, '→', ref.id);
  return { ok: true, uid: ref.id };
});

// ── Placeholder: future admin / trigger functions go here ─────────────
// Example (not deployed yet):
//
// exports.onNewMember = functions
//   .region('asia-east1')
//   .firestore.document('members/{uid}')
//   .onCreate(async (snap, context) => {
//     const member = snap.data();
//     console.info('[onNewMember] New pending member:', member.displayName);
//     // TODO: notify admin via LINE Notify or FCM
//   });
