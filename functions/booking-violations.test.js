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

function extractFrontendFunction(name) {
  const marker = `function ${name}(`;
  const start = frontend.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = frontend.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < frontend.length; i += 1) {
    if (frontend[i] === '{') depth += 1;
    if (frontend[i] === '}' && --depth === 0) {
      return frontend.slice(start, i + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

class HttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const context = {Date, Intl, Number, HttpsError};
vm.createContext(context);
vm.runInContext([
  extractFunction('timestampMillis'),
  extractFunction('addTaipeiCalendarMonth'),
  extractFunction('formatTaipeiDate'),
  extractFunction('assertViolationTargetAllowed'),
].join('\n'), context);

function taipeiMillis(text) {
  return new Date(`${text}+08:00`).getTime();
}

assert.strictEqual(
  context.addTaipeiCalendarMonth(taipeiMillis('2026-08-17T15:30:00')),
  taipeiMillis('2026-09-17T15:30:00'),
);
assert.strictEqual(
  context.addTaipeiCalendarMonth(taipeiMillis('2026-01-31T10:00:00')),
  taipeiMillis('2026-02-28T10:00:00'),
);
assert.strictEqual(
  context.addTaipeiCalendarMonth(taipeiMillis('2028-01-31T10:00:00')),
  taipeiMillis('2028-02-29T10:00:00'),
);
assert(context.formatTaipeiDate(taipeiMillis('2026-09-17T15:30:00')).includes('2026'));

assert.doesNotThrow(() => context.assertViolationTargetAllowed(
  'ADMIN', 'MEMBER', {role: 'member'},
));
assert.doesNotThrow(() => context.assertViolationTargetAllowed(
  'OWNER', 'COACH', {role: 'coach'},
));
assert.throws(
  () => context.assertViolationTargetAllowed('ADMIN', 'ADMIN', {role: 'admin'}),
  (error) => error.code === 'permission-denied',
);

const uiContext = {Date, Number, isFinite};
vm.createContext(uiContext);
vm.runInContext([
  extractFrontendFunction('_timestampMs'),
  extractFrontendFunction('_effectiveViolationPoints'),
  extractFrontendFunction('_violationHistoryStatus'),
].join('\n'), uiContext);
assert.strictEqual(uiContext._effectiveViolationPoints({
  status: 'suspended', activePoints: 3,
  bookingSuspendedUntil: new Date(Date.now() - 1000),
}), 0);
assert.strictEqual(uiContext._effectiveViolationPoints({
  status: 'suspended', activePoints: 3,
  bookingSuspendedUntil: new Date(Date.now() + 60000),
}), 3);
assert.strictEqual(uiContext._violationHistoryStatus({
  status: 'active', countsTowardCycle: true, cycleId: 'old',
}, {
  status: 'suspended', cycleId: 'old',
  bookingSuspendedUntil: new Date(Date.now() - 1000),
}), '已完成週期');
assert.throws(
  () => context.assertViolationTargetAllowed('ADMIN', 'OWNER', {role: 'owner'}),
  (error) => error.code === 'permission-denied',
);

[
  'exports.createBookingViolation',
  'exports.revokeBookingViolation',
  'exports.deleteBookingViolation',
  "'violation_create'",
  "'violation_revoke'",
  "'violation_delete'",
  "'suspension_start'",
  "'suspension_end'",
  "'suspended_booking_rejected'",
  "'suspended_player_add_rejected'",
  "collection('bookingViolationSummaries')",
].forEach((text) => assert(source.includes(text), `backend wiring missing: ${text}`));

[
  'function openViolationCreate',
  'openViolationHistory(',
  "_callBookingFunction('createBookingViolation'",
  "_callBookingFunction('revokeBookingViolation'",
  "_callBookingFunction('deleteBookingViolation'",
  "n.type==='booking_violation_recorded'",
  '我的違規紀錄',
].forEach((text) => assert(frontend.includes(text), `frontend wiring missing: ${text}`));

[
  'match /bookingViolations/{violationId}',
  'match /bookingViolationSummaries/{memberUid}',
  'match /bookingViolationAuditLogs/{auditId}',
  "'booking_violation_recorded'",
  "'booking_suspension_started'",
].forEach((text) => assert(rules.includes(text), `rules wiring missing: ${text}`));

console.log('PASS suspension expiry uses one Taipei calendar month with end-of-month clamping');
console.log('PASS only member/coach targets are eligible and self/admin/owner targets are blocked');
console.log('PASS callable, UI, audit, notification, summary, and Rules wiring');
console.log('PASS expired summary renders 0/3 and completed-cycle history immediately');
