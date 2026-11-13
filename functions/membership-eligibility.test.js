'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function extractFunctionFrom(text, name) {
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${name} incomplete`);
}
function extractFunction(name) {
  return extractFunctionFrom(source, name);
}

const context = {
  ADMIN_ROLES: new Set(['owner', 'admin']),
  LEGACY_MEMBERSHIP_FALLBACK_END: '2026-12-31',
};
vm.createContext(context);
vm.runInContext([
  'const ADMIN_ROLES=globalThis.ADMIN_ROLES;',
  'const LEGACY_MEMBERSHIP_FALLBACK_END=globalThis.LEGACY_MEMBERSHIP_FALLBACK_END;',
  extractFunction('cleanString'),
  extractFunction('normaliseExpiryDate'),
  extractFunction('isEligibleMember'),
  extractFunction('evaluateMembershipAccess'),
].join('\n'), context);

const member = {
  role: 'member', status: 'approved', approved: true,
  membershipExpiry: '2027/12/31',
};
const period2027 = {
  membershipYear: 2027, startDate: '2027-01-01',
  expiryDate: '2027-12-31', status: 'scheduled',
};

assert.strictEqual(context.evaluateMembershipAccess(
  member, '2026-12-31', []).allowed, true);
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2026-12-31', []).source, 'legacy_2026');
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2027-01-01', []).allowed, false);
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2027-01-01', [period2027]).allowed, true);
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2027-12-31', [period2027]).allowed, true);
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2028-01-01', [period2027]).allowed, false);

assert.strictEqual(context.evaluateMembershipAccess(
  Object.assign({}, member, {status: 'deleted'}),
  '2027-06-01', [period2027]).allowed, false);
assert.strictEqual(context.evaluateMembershipAccess(
  Object.assign({}, member, {status: 'blocked'}),
  '2027-06-01', [period2027]).allowed, false);
assert.strictEqual(context.evaluateMembershipAccess(
  Object.assign({}, member, {role: 'owner'}),
  '2028-01-01', []).allowed, true);
assert.strictEqual(context.evaluateMembershipAccess(
  Object.assign({}, member, {role: 'admin'}),
  '2028-01-01', []).allowed, true);
assert.strictEqual(context.evaluateMembershipAccess(
  Object.assign({}, member, {role: 'coach'}),
  '2027-01-01', []).allowed, false);

assert.strictEqual(context.evaluateMembershipAccess(
  member, '2027-06-01', [Object.assign({}, period2027, {
    status: 'revoked',
  })]).allowed, false);
assert.strictEqual(context.evaluateMembershipAccess(
  member, '2027-06-01', [Object.assign({}, period2027, {
    status: 'resigned',
  })]).allowed, false);

const frontContext = {
  usersCache: {STUDENT: Object.assign({realName: '學生'}, member)},
  membershipPeriodsCache: [Object.assign({memberUid: 'STUDENT'}, period2027)],
  membershipPeriodsLoaded: true,
  _mName: (value) => value.realName || '',
};
vm.createContext(frontContext);
vm.runInContext(extractFunctionFrom(
  frontend, '_teachingStudentEligibilityMessage',
), frontContext);
assert.strictEqual(frontContext._teachingStudentEligibilityMessage(
  ['STUDENT'], '2027-01-01'), '');
frontContext.membershipPeriodsCache = [];
assert(frontContext._teachingStudentEligibilityMessage(
  ['STUDENT'], '2027-01-01').includes('無有效會籍'));
frontContext.membershipPeriodsLoaded = false;
assert.strictEqual(frontContext._teachingStudentEligibilityMessage(
  ['STUDENT'], '2027-01-01'), '');

const accessContext = {};
vm.createContext(accessContext);
vm.runInContext([
  extractFunctionFrom(frontend, '_membershipUiYear'),
  extractFunctionFrom(frontend, '_membershipDateKey'),
  extractFunctionFrom(frontend, '_frontendMembershipAccess'),
].join('\n'), accessContext);
const frontendMember = {
  role: 'member', status: 'approved', membershipExpiry: '2026-12-31',
};
assert.strictEqual(accessContext._frontendMembershipAccess(
  frontendMember, [], '2026-12-31', true).allowed, true);
assert.strictEqual(accessContext._frontendMembershipAccess(
  frontendMember, [], '2027-01-01', true).allowed, false);
assert.strictEqual(accessContext._frontendMembershipAccess(
  frontendMember, [period2027], '2027-01-01', true).allowed, true);
assert.strictEqual(accessContext._frontendMembershipAccess(
  frontendMember, [period2027], '2028-01-01', true).allowed, false);
assert.strictEqual(accessContext._frontendMembershipAccess(
  Object.assign({}, frontendMember, {status: 'blocked'}),
  [period2027], '2027-01-01', true).allowed, false);
['owner', 'admin', 'coach'].forEach((role) => {
  assert.strictEqual(accessContext._frontendMembershipAccess(
    Object.assign({}, frontendMember, {role}), [], '2027-01-01', true,
  ).allowed, true);
});
assert(frontend.includes(".where('memberUid','==',uid)"));
assert(frontend.includes("document.addEventListener('visibilitychange'"));
assert(frontend.includes('_scheduleMembershipBoundaryRefresh();'));

[
  'exports.createBooking',
  'exports.updateBooking',
  'exports.addBookingParticipant',
  'exports.submitBookingExtensionRequest',
  'exports.approveBookingExtensionRequest',
  'assertSelectedTeachingStudentsEligible',
  'assertMembersHaveBookingAccess',
  'assertPlayersNotSuspendedAndAudit',
].forEach((needle) => assert(source.includes(needle), `${needle} missing`));

console.log('membership eligibility tests passed');
