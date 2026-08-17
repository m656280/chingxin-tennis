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

const admin     = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

admin.initializeApp();

const bookingDb = admin.firestore();
const SERVER_TS = admin.firestore.FieldValue.serverTimestamp;
const ADMIN_ROLES = new Set(['owner', 'admin']);
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

function cleanString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isActiveBooking(booking) {
  const status = booking.status || 'active';
  return status === 'active' || status === 'confirmed';
}

function isEligibleMember(member) {
  if (!member) return false;
  if (member.status === 'deleted') return false;
  if (ADMIN_ROLES.has(member.role || '')) {
    return member.status !== 'deleted' && member.status !== 'blocked';
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
  const status = member.status || '';
  if (['deleted', 'blocked', 'resigned', 'rejected', 'pending'].includes(status) ||
      !isEligibleMember(member)) {
    return false;
  }
  const expiry = normaliseExpiryDate(
    member.membershipExpiry || member.expireDate || '',
  );
  return Boolean(expiry && date <= expiry);
}

async function assertSelectedTeachingStudentsEligible(studentUids, date) {
  const selected = [...new Set((studentUids || []).filter(Boolean))];
  if (!selected.length) return;
  const snaps = await bookingDb.getAll(...selected.map((uid) =>
    bookingDb.collection('members').doc(uid)));
  const invalidNames = snaps.reduce((names, snap, index) => {
    const member = snap.exists ? snap.data() || {} : {};
    if (!snap.exists || !hasValidMembershipForBooking(member, date)) {
      names.push(member.realName || member.name ||
        member.displayName || selected[index]);
    }
    return names;
  }, []);
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

function assertExtensionMemberEligible(member, date) {
  if (!isEligibleMember(member)) {
    throw new HttpsError('failed-precondition', '會員目前不具有效資格');
  }
  if (!ADMIN_ROLES.has(member.role || '') &&
      !hasValidMembershipForBooking(member, date)) {
    throw new HttpsError(
      'failed-precondition',
      '會員會籍無法涵蓋申請日期，無法申請加時。',
    );
  }
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
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }

  const actorUid = request.auth.uid;
  const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
  if (!actorSnap.exists) {
    throw new HttpsError('permission-denied', '找不到操作者會員資料');
  }
  const actor = actorSnap.data() || {};

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

exports.createBooking = onCall({region: 'asia-east1'}, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }

  const actorUid = request.auth.uid;
  const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
  if (!actorSnap.exists || !isEligibleMember(actorSnap.data() || {})) {
    throw new HttpsError('permission-denied', '操作者目前不具有效會員資格');
  }
  const actor = actorSnap.data() || {};
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
  const actorName = memberDisplayName(actor, actorUid);
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
      const expiryRaw = subject.membershipExpiry || subject.expireDate || '';
      const expiry = normaliseExpiryDate(expiryRaw);
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
      const sameDateSnap = await transaction.get(
        bookingDb.collection('bookings').where('date', '==', date),
      );
      await assertPlayersNotSuspendedInTransaction(
        transaction, bookingPlayerUids, 'suspended_booking_rejected',
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
      if (findParticipantConflictUid(sameDateBookings, booking, '')) {
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
  const actorName = memberDisplayName(context.actor, context.actorUid);
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
      const expiryRaw = subject.membershipExpiry || subject.expireDate || '';
      const expiry = normaliseExpiryDate(expiryRaw);
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
    const newDateSnap = await transaction.get(
      bookingDb.collection('bookings').where('date', '==', date),
    );
    const oldDateSnap = context.booking.date === date ? newDateSnap :
      await transaction.get(bookingDb.collection('bookings')
        .where('date', '==', context.booking.date));
    await assertPlayersNotSuspendedInTransaction(
      transaction, bookingPlayerUids, 'suspended_booking_rejected',
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
    if (findParticipantConflictUid(
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
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }
  const actorUid = request.auth.uid;
  const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
  if (!actorSnap.exists) {
    throw new HttpsError('permission-denied', '找不到操作者會員資料');
  }
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

  const actor = actorSnap.data() || {};
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
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
    }
    const requesterUid = request.auth.uid;
    const memberSnap = await bookingDb.collection('members')
      .doc(requesterUid).get();
    if (!memberSnap.exists) {
      throw new HttpsError('permission-denied', '找不到申請會員資料');
    }
    const member = memberSnap.data() || {};
    const requesterName = memberDisplayName(member, requesterUid);
    const input = request.data || {};
    const date = cleanString(input.date, 10);
    const court = cleanString(input.court, 20);
    const startTime = cleanString(input.startTime, 5);
    const endTime = cleanString(input.endTime, 5);
    assertExtensionTimeInput(date, court, startTime, endTime);
    assertExtensionMemberEligible(member, date);
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
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
    }
    const actorUid = request.auth.uid;
    const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
    const actor = actorSnap.exists ? actorSnap.data() || {} : {};
    if (!actorSnap.exists || !ADMIN_ROLES.has(actor.role || '')) {
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
      assertExtensionMemberEligible(member, extensionRequest.date);

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
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
    }
    const actorUid = request.auth.uid;
    const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
    const actor = actorSnap.exists ? actorSnap.data() || {} : {};
    if (!actorSnap.exists || !ADMIN_ROLES.has(actor.role || '')) {
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
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }
  const actorUid = request.auth.uid;
  const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
  const actor = actorSnap.exists ? actorSnap.data() || {} : {};
  const allowed = ownerOnly ? actor.role === 'owner' :
    ADMIN_ROLES.has(actor.role || '');
  if (!actorSnap.exists || !allowed) {
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
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', '請重新登入 LINE 後再試');
  }

  const actorUid = request.auth.uid;
  const actorSnap = await bookingDb.collection('members').doc(actorUid).get();
  const actor = actorSnap.exists ? actorSnap.data() || {} : {};
  if (!actorSnap.exists || actor.role !== 'owner') {
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

// ── createManualMember ────────────────────────────────────────────────
// 管理員手動建立會員（無 LINE 帳號者）。
// 由 Admin SDK 寫入 Firestore（bypass rules），
// 呼叫者身份驗證：request.auth.uid → members/{uid}.role 必須為 owner/admin。
// docId = Firestore auto-ID，uid 欄位 = docId（與 LINE 會員結構一致）。
exports.createManualMember = onCall({ region: 'asia-east1' }, async (request) => {
  // ① 必須已完成 Firebase Auth 登入
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Firebase Auth 尚未登入，請重新用 LINE 登入後再試');
  }

  // ② 呼叫者 role 以 Firestore member doc 為準（不信任 client、不依賴可能過期的 token claims）
  const db = admin.firestore();
  const callerSnap = await db.collection('members').doc(request.auth.uid).get();
  const callerRole = callerSnap.exists ? (callerSnap.data().role || '') : '';
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
    approvedBy:        request.auth.uid,
    lastLoginAt:       null,
  });

  console.info('[createManualMember]', realName, '| role:', role, '| by:', request.auth.uid, '→', ref.id);
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
