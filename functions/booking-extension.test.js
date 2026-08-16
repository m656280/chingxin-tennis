'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const rules = fs.readFileSync(require.resolve('../firestore.rules'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} incomplete`);
}

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const context = {
  ADMIN_ROLES: new Set(['owner', 'admin']),
  EXTENSION_DURATION_MINUTES: 60,
  HttpsError,
  Date,
  Number,
  Set,
};
vm.createContext(context);
vm.runInContext([
  'const ADMIN_ROLES = globalThis.ADMIN_ROLES;',
  'const EXTENSION_DURATION_MINUTES = globalThis.EXTENSION_DURATION_MINUTES;',
  extractFunction('cleanString'),
  extractFunction('isActiveBooking'),
  extractFunction('isEligibleMember'),
  extractFunction('bookingStartMs'),
  extractFunction('normaliseBookingMode'),
  extractFunction('normaliseExpiryDate'),
  extractFunction('hasValidMembershipForBooking'),
  extractFunction('timeToMinutes'),
  extractFunction('bookingEndMs'),
  extractFunction('bookingIntervalsOverlap'),
  extractFunction('bookingParticipantUids'),
  extractFunction('findCourtConflict'),
  extractFunction('findParticipantConflictUid'),
  extractFunction('generalBookingPlayerUids'),
  extractFunction('generalMinutesForUid'),
  extractFunction('normalGeneralMinutesForUid'),
  extractFunction('hasApprovedExtension'),
  extractFunction('extensionRequestDocId'),
  extractFunction('bookingDateLockId'),
  extractFunction('assertExtensionTimeInput'),
  extractFunction('assertExtensionMemberEligible'),
].join('\n'), context);

function booking(id, start, end, court, players, status = 'active', extra = {}) {
  return Object.assign({
    id,
    date: '2026-08-20',
    startTime: start,
    endTime: end,
    court,
    players,
    mode: 'general',
    status,
  }, extra);
}

const existing = [
  booking('one', '13:00', '14:00', 'hard_a', ['A', 'B']),
  booking('two', '14:00', '15:00', 'hard_b', ['B']),
  booking('cancelled', '15:00', '16:00', 'hard_a', ['B'], 'cancelled'),
  booking('void', '16:00', '17:00', 'hard_b', ['B'], 'void'),
];

assert.strictEqual(context.generalMinutesForUid(existing, 'A'), 60);
assert.strictEqual(context.generalMinutesForUid(existing, 'B'), 120);
assert.strictEqual(context.hasApprovedExtension(existing, 'B'), false);

const approved = booking(
  'extension', '17:00', '18:00', 'hard_a', ['B'], 'active',
  {extensionStatus: 'approved'},
);
assert.strictEqual(context.generalMinutesForUid(existing.concat(approved), 'B'), 180);
assert.strictEqual(
  context.normalGeneralMinutesForUid(existing.concat(approved), 'B'), 120,
);
assert.strictEqual(context.hasApprovedExtension(existing.concat(approved), 'B'), true);

assert.doesNotThrow(() => context.assertExtensionTimeInput(
  '2026-08-20', 'hard_a', '18:00', '19:00',
));
assert.throws(
  () => context.assertExtensionTimeInput(
    '2026-08-20', 'hard_a', '18:00', '19:30',
  ),
  (error) => error.code === 'invalid-argument',
);
assert.throws(
  () => context.assertExtensionTimeInput(
    '2026-08-20', 'clay_a', '18:00', '19:00',
  ),
  (error) => error.code === 'invalid-argument',
);

const candidate = booking('new', '13:30', '14:30', 'hard_a', ['C']);
assert.strictEqual(context.findCourtConflict(existing, candidate, '').id, 'one');
assert.strictEqual(context.findParticipantConflictUid(
  existing, booking('new', '13:30', '14:30', 'clay_a', ['B']), '',
), 'B');
assert.strictEqual(context.findCourtConflict(
  [booking('cancelled', '13:00', '14:00', 'hard_a', ['C'], 'cancelled')],
  candidate,
  '',
), null);

assert.strictEqual(
  context.extensionRequestDocId('member-1', '2026-08-20'),
  'member-1_2026-08-20',
);
assert.strictEqual(context.bookingDateLockId('2026-08-20'), '2026-08-20');
assert.doesNotThrow(() => context.assertExtensionMemberEligible({
  status: 'approved', approved: true, membershipExpiry: '2026-12-31',
}, '2026-08-20'));
assert.throws(() => context.assertExtensionMemberEligible({
  status: 'approved', approved: true, membershipExpiry: '2026-08-19',
}, '2026-08-20'));

[
  'exports.submitBookingExtensionRequest',
  'exports.approveBookingExtensionRequest',
  'exports.rejectBookingExtensionRequest',
  'exports.voidBooking',
  'exports.leaveBooking',
  'exports.repairBookingOverlap',
  "collection('bookingMutationLocks')",
  "extensionStatus: 'approved'",
  "booking.extensionStatus === 'approved'",
  'transaction.set(bookingRef, booking)',
].forEach((text) => assert(source.includes(text), `backend wiring missing: ${text}`));

[
  'id="submitExtensionRequestBtn"',
  "_callBookingFunction('submitBookingExtensionRequest'",
  "_callBookingFunction('approveBookingExtensionRequest'",
  "_callBookingFunction('rejectBookingExtensionRequest'",
  "_callBookingFunction('voidBooking'",
  "_callBookingFunction('leaveBooking'",
  "_callBookingFunction('repairBookingOverlap'",
  'pendingMemberCount + _pendingExtensionRequests().length',
  "n.type==='booking_extension_approved'",
  "n.type==='booking_extension_revoked'",
  "b.extensionStatus!=='approved'",
].forEach((text) => assert(frontend.includes(text), `frontend wiring missing: ${text}`));

[
  'match /bookingExtensionRequests/{requestId}',
  'match /bookingExtensionAuditLogs/{auditId}',
  'match /bookingMutationLocks/{lockId}',
  'isExtensionProtectedUpdateAllowed()',
  "'booking_extension_approved'",
  "'booking_extension_revoked'",
].forEach((text) => assert(rules.includes(text), `rules wiring missing: ${text}`));

console.log('PASS all players[] minutes are counted across Hard A / Hard B');
console.log('PASS cancelled / void bookings are excluded');
console.log('PASS approved extension raises the daily total from 120 to 180');
console.log('PASS extension booking is excluded from the qualifying 120 minutes');
console.log('PASS a second approved extension is detectable');
console.log('PASS extension duration is exactly 60 minutes and hard courts only');
console.log('PASS same-court and member time conflicts are detected');
console.log('PASS membership eligibility and expiry are validated');
console.log('PASS deterministic member/date request ID and date mutex ID');
console.log('PASS callable, UI, notification, audit, and Rules wiring');
