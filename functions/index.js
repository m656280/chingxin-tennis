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
const MEMBERSHIP_EXPIRY_CANCEL_REASON =
  '超過繳費會籍有效期限，此預約不成立。';

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
  await bookingRef.set(booking);
  return {ok: true, bookingId: bookingRef.id};
});

exports.updateBooking = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  if (!isActiveBooking(context.booking)) {
    throw new HttpsError('failed-precondition', '此預約已取消或作廢');
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

  await context.bookingRef.update(update);
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
  if (targetUid) {
    if (players.includes(targetUid)) {
      throw new HttpsError('already-exists', '此會員已在預約中');
    }
    const targetSnap = await bookingDb.collection('members').doc(targetUid).get();
    if (!targetSnap.exists) {
      throw new HttpsError('not-found', '找不到指定會員');
    }
    if (!isEligibleMember(targetSnap.data() || {})) {
      throw new HttpsError('failed-precondition', '此會員目前不具有效資格');
    }
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

  const batch = bookingDb.batch();
  batch.update(context.bookingRef, update);
  addAuditWrite(
    batch,
    context,
    'participant_added',
    auditTargetUid,
    reason,
    auditTargetLabel,
  );
  await batch.commit();
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

  const batch = bookingDb.batch();
  batch.update(context.bookingRef, update);
  addAuditWrite(
    batch,
    context,
    'participant_removed',
    auditTargetUid,
    reason,
    auditTargetLabel,
  );
  await batch.commit();
  return {ok: true};
});

exports.cancelBooking = onCall({region: 'asia-east1'}, async (request) => {
  const context = await getBookingActorContext(request);
  const reason = cleanString((request.data || {}).reason, 300);
  if (ADMIN_ROLES.has(context.actorRole) && !reason) {
    throw new HttpsError('invalid-argument', '管理員取消預約必須填寫原因');
  }
  if (!isActiveBooking(context.booking)) {
    throw new HttpsError('failed-precondition', '此預約已取消或作廢');
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

  const batch = bookingDb.batch();
  batch.update(context.bookingRef, update);
  addAuditWrite(
    batch,
    context,
    'cancel',
    context.booking.createdBy || '',
    reason,
    '',
  );
  if (reason === MEMBERSHIP_EXPIRY_CANCEL_REASON) {
    addMembershipExpiryCancelNotification(batch, context);
  }
  await batch.commit();
  return {ok: true, cancelledByName: actorName};
});

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
