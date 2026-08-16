'use strict';

const assert = require('assert');
const admin = require('firebase-admin');

let autoId = 0;
const clone = (value) => value === undefined ? undefined :
  JSON.parse(JSON.stringify(value));

class MockDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = clone(data);
  }
  data() { return clone(this._data); }
}

class MockQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
  }
}

class MockDocumentReference {
  constructor(db, collectionName, id) {
    this._db = db;
    this.collectionName = collectionName;
    this.id = id;
  }
  get() { return Promise.resolve(this._db._getDoc(this)); }
  set(data, options) { this._db._setDoc(this, data, options); return Promise.resolve(); }
  update(data) { this._db._updateDoc(this, data); return Promise.resolve(); }
}

class MockQuery {
  constructor(db, collectionName, filters = []) {
    this._db = db;
    this.collectionName = collectionName;
    this.filters = filters;
  }
  where(field, op, value) {
    assert.strictEqual(op, '==');
    return new MockQuery(
      this._db, this.collectionName,
      this.filters.concat([{field, value}]),
    );
  }
  get() { return Promise.resolve(this._db._getQuery(this)); }
}

class MockCollectionReference extends MockQuery {
  doc(id) {
    return new MockDocumentReference(
      this._db, this.collectionName, id || `auto_${++autoId}`,
    );
  }
}

class MockTransaction {
  constructor(db) {
    this._db = db;
    this._writes = [];
  }
  get(target) {
    if (target instanceof MockDocumentReference) {
      return Promise.resolve(this._db._getDoc(target));
    }
    return Promise.resolve(this._db._getQuery(target));
  }
  set(ref, data, options) {
    this._writes.push({type: 'set', ref, data, options});
  }
  update(ref, data) {
    this._writes.push({type: 'update', ref, data});
  }
  commit() {
    this._writes.forEach((write) => {
      if (write.type === 'set') {
        this._db._setDoc(write.ref, write.data, write.options);
      } else {
        this._db._updateDoc(write.ref, write.data);
      }
    });
  }
}

class MockFirestore {
  constructor() {
    this._collections = new Map();
    this._transactionTail = Promise.resolve();
  }
  collection(name) { return new MockCollectionReference(this, name); }
  getAll(...refs) { return Promise.all(refs.map((ref) => ref.get())); }
  batch() {
    const transaction = new MockTransaction(this);
    return {
      set: (...args) => transaction.set(...args),
      update: (...args) => transaction.update(...args),
      commit: async () => transaction.commit(),
    };
  }
  runTransaction(callback) {
    const run = this._transactionTail.then(async () => {
      const transaction = new MockTransaction(this);
      const result = await callback(transaction);
      transaction.commit();
      return result;
    });
    this._transactionTail = run.catch(() => undefined);
    return run;
  }
  _map(name) {
    if (!this._collections.has(name)) this._collections.set(name, new Map());
    return this._collections.get(name);
  }
  _getDoc(ref) {
    return new MockDocumentSnapshot(ref, this._map(ref.collectionName).get(ref.id));
  }
  _getQuery(query) {
    const docs = [];
    this._map(query.collectionName).forEach((data, id) => {
      if (query.filters.every((filter) => data[filter.field] === filter.value)) {
        docs.push(new MockDocumentSnapshot(
          new MockDocumentReference(this, query.collectionName, id), data,
        ));
      }
    });
    return new MockQuerySnapshot(docs);
  }
  _resolvedValue(current, value) {
    if (value && value.__mockFieldValue === 'serverTimestamp') {
      return new Date().toISOString();
    }
    if (value && value.__mockFieldValue === 'increment') {
      return (Number(current) || 0) + value.amount;
    }
    if (value && value.__mockFieldValue === 'arrayUnion') {
      return [...new Set((Array.isArray(current) ? current : [])
        .concat(value.values))];
    }
    if (value && value.__mockFieldValue === 'arrayRemove') {
      return (Array.isArray(current) ? current : [])
        .filter((item) => !value.values.includes(item));
    }
    return clone(value);
  }
  _setDoc(ref, data, options) {
    const map = this._map(ref.collectionName);
    const current = map.get(ref.id) || {};
    const next = options && options.merge ? Object.assign({}, current) : {};
    Object.keys(data).forEach((key) => {
      next[key] = this._resolvedValue(current[key], data[key]);
    });
    map.set(ref.id, next);
  }
  _updateDoc(ref, data) {
    const map = this._map(ref.collectionName);
    if (!map.has(ref.id)) throw new Error(`missing document ${ref.collectionName}/${ref.id}`);
    const current = map.get(ref.id);
    const next = Object.assign({}, current);
    Object.keys(data).forEach((key) => {
      next[key] = this._resolvedValue(current[key], data[key]);
    });
    map.set(ref.id, next);
  }
}

const db = new MockFirestore();
const firestoreMock = () => db;
firestoreMock.FieldValue = {
  serverTimestamp: () => ({__mockFieldValue: 'serverTimestamp'}),
  increment: (amount) => ({__mockFieldValue: 'increment', amount}),
  arrayUnion: (...values) => ({__mockFieldValue: 'arrayUnion', values}),
  arrayRemove: (...values) => ({__mockFieldValue: 'arrayRemove', values}),
};
firestoreMock.Timestamp = {fromMillis: (millis) => new Date(millis)};
Object.defineProperty(admin, 'initializeApp', {value: () => ({}), configurable: true});
Object.defineProperty(admin, 'firestore', {value: firestoreMock, configurable: true});

const functions = require('./index.js');
const member = (name, role = 'member') => ({
  realName: name,
  displayName: name,
  role,
  status: 'approved',
  approved: true,
  membershipExpiry: '2031-12-31',
});
const normalBooking = (date, startTime, endTime, court, players) => ({
  date,
  startTime,
  endTime,
  court,
  players,
  guests: [],
  mode: 'general',
  status: 'active',
  createdBy: players[0],
  participantCount: players.length,
  capacity: 4,
});
const call = (handler, uid, data) => handler.run({auth: {uid}, data});

async function seedMember(uid, name, role) {
  await db.collection('members').doc(uid).set(member(name, role));
}

async function seedTwoHours(date, players) {
  await Promise.all([
    db.collection('bookings').doc(`${date}_one_${players[0]}`).set(
      normalBooking(date, '13:00', '14:00', 'hard_a', players),
    ),
    db.collection('bookings').doc(`${date}_two_${players[0]}`).set(
      normalBooking(date, '14:00', '15:00', 'hard_b', players),
    ),
  ]);
}

async function main() {
  await Promise.all([
    seedMember('ADMIN', '管理員', 'admin'),
    seedMember('OWNER', 'Owner', 'owner'),
    seedMember('B', '林昱丞'),
    seedMember('C', '林佑涵'),
    seedMember('D', '測試會員丁'),
    seedMember('E', '測試會員戊'),
  ]);

  const approvalDate = '2030-08-20';
  await seedTwoHours(approvalDate, ['B', 'C']);
  const requestInput = {
    date: approvalDate,
    court: 'hard_a',
    startTime: '16:00',
    endTime: '17:00',
  };
  const submitted = await Promise.all([
    call(functions.submitBookingExtensionRequest, 'B', requestInput),
    call(functions.submitBookingExtensionRequest, 'C', requestInput),
  ]);
  assert(submitted.every((result) => result.ok));
  assert.strictEqual((await db.collection('bookings')
    .where('extensionStatus', '==', 'approved').get()).size, 0);

  const requestIds = submitted.map((result) => result.requestId);
  const approvals = await Promise.allSettled(requestIds.map((requestId) =>
    call(functions.approveBookingExtensionRequest, 'ADMIN', {requestId})));
  assert.strictEqual(approvals.filter((result) => result.status === 'fulfilled').length, 1);
  assert.strictEqual(approvals.filter((result) => result.status === 'rejected').length, 1);
  const approvedResult = approvals.find((result) => result.status === 'fulfilled').value;
  const extensionBooking = (await db.collection('bookings')
    .doc(approvedResult.bookingId).get()).data();
  assert.strictEqual(extensionBooking.mode, 'general');
  assert.strictEqual(extensionBooking.extensionStatus, 'approved');
  assert.strictEqual(extensionBooking.createdBy, extensionBooking.players[0]);
  assert.deepStrictEqual(extensionBooking.guests, []);
  assert.strictEqual(extensionBooking.capacity, 1);

  await assert.rejects(call(
    functions.addBookingParticipant,
    'ADMIN',
    {bookingId: approvedResult.bookingId, targetUid: 'D'},
  ), /加時預約僅限申請會員本人使用/);
  await assert.rejects(call(
    functions.submitBookingExtensionRequest,
    extensionBooking.createdBy,
    requestInput,
  ), /已有一筆核准的加時/);

  const approvedRequest = (await db.collection('bookingExtensionRequests')
    .doc(extensionBooking.extensionRequestId).get()).data();
  assert.strictEqual(approvedRequest.status, 'approved');
  assert.strictEqual(approvedRequest.bookingId, approvedResult.bookingId);
  assert((await db.collection('bookingExtensionAuditLogs')
    .where('requestId', '==', extensionBooking.extensionRequestId).get()).size >= 2);
  assert((await db.collection('notifications')
    .where('requestId', '==', extensionBooking.extensionRequestId).get()).size >= 1);

  const rejectDate = '2030-08-21';
  await seedTwoHours(rejectDate, ['B']);
  const rejectedSubmit = await call(
    functions.submitBookingExtensionRequest,
    'B',
    {date: rejectDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  await call(functions.rejectBookingExtensionRequest, 'ADMIN', {
    requestId: rejectedSubmit.requestId,
    reason: '測試拒絕',
  });
  let rejectedRequest = (await db.collection('bookingExtensionRequests')
    .doc(rejectedSubmit.requestId).get()).data();
  assert.strictEqual(rejectedRequest.status, 'rejected');
  assert.strictEqual(rejectedRequest.bookingId, '');

  await call(
    functions.submitBookingExtensionRequest,
    'B',
    {date: rejectDate, court: 'hard_b', startTime: '17:00', endTime: '18:00'},
  );
  rejectedRequest = (await db.collection('bookingExtensionRequests')
    .doc(rejectedSubmit.requestId).get()).data();
  assert.strictEqual(rejectedRequest.status, 'pending');
  assert.strictEqual(rejectedRequest.attempt, 2);
  assert.strictEqual((await db.collection('bookingExtensionAuditLogs')
    .where('requestId', '==', rejectedSubmit.requestId)
    .where('action', '==', 'extension_requested').get()).size, 2);

  const duplicateDate = '2030-08-22';
  await seedTwoHours(duplicateDate, ['D']);
  const duplicateInput = {
    date: duplicateDate,
    court: 'hard_a',
    startTime: '16:00',
    endTime: '17:00',
  };
  const duplicateSubmits = await Promise.allSettled([
    call(functions.submitBookingExtensionRequest, 'D', duplicateInput),
    call(functions.submitBookingExtensionRequest, 'D', duplicateInput),
  ]);
  assert.strictEqual(duplicateSubmits.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(duplicateSubmits.filter((r) => r.status === 'rejected').length, 1);

  const expiredRequestId = 'E_2026-08-15';
  await db.collection('bookingExtensionRequests').doc(expiredRequestId).set({
    requesterUid: 'E',
    requesterName: '測試會員戊',
    date: '2026-08-15',
    court: 'hard_a',
    startTime: '10:00',
    endTime: '11:00',
    durationMinutes: 60,
    status: 'pending',
    attempt: 1,
  });
  await assert.rejects(call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: expiredRequestId},
  ), /expired/);
  assert.strictEqual((await db.collection('bookingExtensionRequests')
    .doc(expiredRequestId).get()).data().status, 'expired');

  const createDate = '2030-08-23';
  const createInput = (uid) => ({booking: {
    date: createDate,
    court: 'hard_a',
    startTime: '18:00',
    endTime: '19:00',
    mode: 'general',
    players: [uid],
    guests: [],
    capacity: 4,
    participantCount: 1,
  }});
  const concurrentCreates = await Promise.allSettled([
    call(functions.createBooking, 'D', createInput('D')),
    call(functions.createBooking, 'E', createInput('E')),
  ]);
  assert.strictEqual(concurrentCreates.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(concurrentCreates.filter((r) => r.status === 'rejected').length, 1);

  const mixedDate = '2030-08-24';
  await seedTwoHours(mixedDate, ['B']);
  const mixedSubmit = await call(
    functions.submitBookingExtensionRequest,
    'B',
    {date: mixedDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const mixedCreateInput = {booking: {
    date: mixedDate,
    court: 'hard_a',
    startTime: '16:00',
    endTime: '17:00',
    mode: 'general',
    players: ['E'],
    guests: [],
    capacity: 4,
    participantCount: 1,
  }};
  const mixedRace = await Promise.allSettled([
    call(functions.approveBookingExtensionRequest, 'ADMIN', {
      requestId: mixedSubmit.requestId,
    }),
    call(functions.createBooking, 'E', mixedCreateInput),
  ]);
  assert.strictEqual(mixedRace.filter((r) => r.status === 'fulfilled').length, 1);
  assert.strictEqual(mixedRace.filter((r) => r.status === 'rejected').length, 1);
  const mixedBookings = (await db.collection('bookings')
    .where('date', '==', mixedDate).get()).docs
    .map((snap) => snap.data())
    .filter((item) => item.court === 'hard_a' &&
      item.startTime === '16:00' && item.endTime === '17:00');
  assert.strictEqual(mixedBookings.length, 1);

  const lifecycleDate = '2030-08-25';
  await seedTwoHours(lifecycleDate, ['B', 'C']);
  const lifecycleB = await call(
    functions.submitBookingExtensionRequest,
    'B',
    {date: lifecycleDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const lifecycleC = await call(
    functions.submitBookingExtensionRequest,
    'C',
    {date: lifecycleDate, court: 'hard_b', startTime: '16:00', endTime: '17:00'},
  );
  const lifecycleApprovals = await Promise.all([
    call(functions.approveBookingExtensionRequest, 'ADMIN', {
      requestId: lifecycleB.requestId,
    }),
    call(functions.approveBookingExtensionRequest, 'ADMIN', {
      requestId: lifecycleC.requestId,
    }),
  ]);
  const lifecycleCancel = await call(functions.cancelBooking, 'B', {
    bookingId: `${lifecycleDate}_one_B`,
    reason: '測試取消原一般預約',
  });
  assert.strictEqual(lifecycleCancel.revokedExtensionBookingIds.length, 2);
  for (const approval of lifecycleApprovals) {
    assert.strictEqual((await db.collection('bookings')
      .doc(approval.bookingId).get()).data().status, 'cancelled');
  }
  for (const requestId of [lifecycleB.requestId, lifecycleC.requestId]) {
    assert.strictEqual((await db.collection('bookingExtensionRequests')
      .doc(requestId).get()).data().status, 'revoked');
    assert.strictEqual((await db.collection('bookingExtensionAuditLogs')
      .where('requestId', '==', requestId).get()).docs
      .some((snap) => snap.data().action === 'extension_revoked'), true);
    assert.strictEqual((await db.collection('notifications')
      .doc(`booking_extension_revoked_${requestId}`).get()).exists, true);
  }

  const extensionCancelDate = '2030-08-26';
  await seedTwoHours(extensionCancelDate, ['B']);
  const extensionCancelRequest = await call(
    functions.submitBookingExtensionRequest,
    'B',
    {
      date: extensionCancelDate,
      court: 'hard_a',
      startTime: '16:00',
      endTime: '17:00',
    },
  );
  const extensionCancelApproval = await call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: extensionCancelRequest.requestId},
  );
  await call(functions.cancelBooking, 'B', {
    bookingId: extensionCancelApproval.bookingId,
    reason: '會員取消加時預約',
  });
  assert.strictEqual((await db.collection('bookingExtensionRequests')
    .doc(extensionCancelRequest.requestId).get()).data().status, 'revoked');
  await assert.rejects(call(
    functions.submitBookingExtensionRequest,
    'B',
    {
      date: extensionCancelDate,
      court: 'hard_b',
      startTime: '18:00',
      endTime: '19:00',
    },
  ), /曾核准/);

  const removeDate = '2030-08-30';
  await seedTwoHours(removeDate, ['B', 'C']);
  const removeRequest = await call(
    functions.submitBookingExtensionRequest,
    'C',
    {date: removeDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const removeApproval = await call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: removeRequest.requestId},
  );
  await call(functions.removeBookingParticipant, 'ADMIN', {
    bookingId: `${removeDate}_one_B`,
    targetUid: 'C',
    reason: '測試移除球友',
  });
  assert.strictEqual((await db.collection('bookings')
    .doc(removeApproval.bookingId).get()).data().status, 'cancelled');

  const leaveDate = '2030-08-31';
  await seedTwoHours(leaveDate, ['B', 'C']);
  const leaveRequest = await call(
    functions.submitBookingExtensionRequest,
    'C',
    {date: leaveDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const leaveApproval = await call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: leaveRequest.requestId},
  );
  await call(functions.leaveBooking, 'C', {
    bookingId: `${leaveDate}_one_B`,
  });
  assert.strictEqual((await db.collection('bookings')
    .doc(leaveApproval.bookingId).get()).data().status, 'cancelled');

  const updateDate = '2030-09-01';
  await seedTwoHours(updateDate, ['B']);
  const updateRequest = await call(
    functions.submitBookingExtensionRequest,
    'B',
    {date: updateDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const updateApproval = await call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: updateRequest.requestId},
  );
  await call(functions.updateBooking, 'B', {booking: {
    date: updateDate,
    court: 'hard_a',
    startTime: '13:00',
    endTime: '13:30',
    mode: 'general',
    note: '',
  }, bookingId: `${updateDate}_one_B`});
  assert.strictEqual((await db.collection('bookings')
    .doc(updateApproval.bookingId).get()).data().status, 'cancelled');

  const voidDate = '2030-08-27';
  await seedTwoHours(voidDate, ['D']);
  const voidRequest = await call(
    functions.submitBookingExtensionRequest,
    'D',
    {date: voidDate, court: 'hard_a', startTime: '16:00', endTime: '17:00'},
  );
  const voidApproval = await call(
    functions.approveBookingExtensionRequest,
    'ADMIN',
    {requestId: voidRequest.requestId},
  );
  await call(functions.voidBooking, 'OWNER', {
    bookingId: `${voidDate}_one_D`,
    reason: '測試作廢原一般預約',
  });
  assert.strictEqual((await db.collection('bookings')
    .doc(voidApproval.bookingId).get()).data().status, 'cancelled');
  assert.strictEqual((await db.collection('bookingExtensionRequests')
    .doc(voidRequest.requestId).get()).data().status, 'revoked');

  const cancelApprovalRaceDate = '2030-08-28';
  await seedTwoHours(cancelApprovalRaceDate, ['D']);
  const raceRequest = await call(
    functions.submitBookingExtensionRequest,
    'D',
    {
      date: cancelApprovalRaceDate,
      court: 'hard_a',
      startTime: '16:00',
      endTime: '17:00',
    },
  );
  await Promise.allSettled([
    call(functions.approveBookingExtensionRequest, 'ADMIN', {
      requestId: raceRequest.requestId,
    }),
    call(functions.cancelBooking, 'D', {
      bookingId: `${cancelApprovalRaceDate}_one_D`,
      reason: '併發取消測試',
    }),
  ]);
  const raceBookings = (await db.collection('bookings')
    .where('date', '==', cancelApprovalRaceDate).get()).docs
    .map((snap) => snap.data());
  const raceActiveExtension = raceBookings.find((item) =>
    item.extensionStatus === 'approved' && item.status === 'active');
  assert.strictEqual(raceActiveExtension, undefined);

  const repairRaceDate = '2030-08-29';
  await db.collection('bookings').doc('repair_race_source').set(
    normalBooking(repairRaceDate, '18:00', '19:00', 'hard_a', ['D']),
  );
  const repairRace = await Promise.allSettled([
    call(functions.repairBookingOverlap, 'OWNER', {
      bookingId: 'repair_race_source',
      targetCourt: 'hard_b',
    }),
    call(functions.createBooking, 'E', {booking: {
      date: repairRaceDate,
      court: 'hard_b',
      startTime: '18:00',
      endTime: '19:00',
      mode: 'general',
      players: ['E'],
      guests: [],
      capacity: 4,
      participantCount: 1,
    }}),
  ]);
  assert.strictEqual(repairRace.filter((item) =>
    item.status === 'fulfilled').length, 1);
  assert.strictEqual((await db.collection('bookings')
    .where('date', '==', repairRaceDate).get()).docs
    .map((snap) => snap.data())
    .filter((item) => item.court === 'hard_b' && item.status === 'active')
    .length, 1);

  const participantRaceDate = '2030-09-02';
  await db.collection('bookings').doc('participant_existing').set(
    normalBooking(
      participantRaceDate, '13:00', '14:00', 'hard_a', ['D'],
    ),
  );
  await db.collection('bookings').doc('participant_candidate_one').set(
    normalBooking(
      participantRaceDate, '14:00', '15:00', 'hard_a', ['B'],
    ),
  );
  await db.collection('bookings').doc('participant_candidate_two').set(
    normalBooking(
      participantRaceDate, '15:00', '16:00', 'hard_b', ['C'],
    ),
  );
  const participantRace = await Promise.allSettled([
    call(functions.addBookingParticipant, 'ADMIN', {
      bookingId: 'participant_candidate_one', targetUid: 'D',
    }),
    call(functions.addBookingParticipant, 'ADMIN', {
      bookingId: 'participant_candidate_two', targetUid: 'D',
    }),
  ]);
  assert.strictEqual(participantRace.filter((item) =>
    item.status === 'fulfilled').length, 1);

  console.log('PASS submit creates only a pending extension request');
  console.log('PASS concurrent approvals create exactly one booking for one court slot');
  console.log('PASS approved booking keeps general mode and requester ownership');
  console.log('PASS extension booking blocks participant additions');
  console.log('PASS one approved extension per member/day');
  console.log('PASS approval notification and extension audit are written');
  console.log('PASS rejected request can be resubmitted with audit history');
  console.log('PASS concurrent duplicate submits leave only one pending request');
  console.log('PASS stale pending request becomes expired and cannot be approved');
  console.log('PASS normal createBooking shares the date mutex with approval');
  console.log('PASS concurrent normal booking versus extension approval creates one slot');
  console.log('PASS cancelling one multi-player basis booking revokes every affected extension');
  console.log('PASS extension cancellation synchronizes its request to revoked');
  console.log('PASS a revoked approved extension cannot be requested again that day');
  console.log('PASS participant removal and self-leave preserve extension eligibility');
  console.log('PASS editing a basis booking revokes an invalid extension');
  console.log('PASS owner void uses the mutex and revokes an invalid extension');
  console.log('PASS concurrent cancellation versus approval leaves no invalid active extension');
  console.log('PASS owner repair rechecks conflict under the shared date mutex');
  console.log('PASS concurrent participant additions share the daily mutex');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
