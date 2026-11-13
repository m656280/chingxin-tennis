'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = frontend.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = frontend.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < frontend.length; index += 1) {
    if (frontend[index] === '{') depth += 1;
    if (frontend[index] === '}' && --depth === 0) return frontend.slice(start, index + 1);
  }
  throw new Error(`${name} incomplete`);
}

const context = {
  membershipPeriodsCache: [],
  membershipPeriodsLoaded: true,
  financeRecords: [],
};
vm.createContext(context);
vm.runInContext([
  extractFunction('_effectiveFinanceMembershipExpiry'),
  extractFunction('_membershipUiYear'),
  extractFunction('_memberYearPeriods'),
  extractFunction('_memberManagementPeriodState'),
  extractFunction('_financeRecordMembershipYear'),
  extractFunction('_calcMemberFeeStatus'),
  extractFunction('_memberManagementPlan'),
].join('\n'), context);

const member = {userId:'memberA', status:'approved', role:'member'};
context.membershipPeriodsCache = [
  {memberUid:'memberA', membershipYear:2026, membershipPlan:'annual_standard',
    startDate:'2026-01-01', expiryDate:'2026-12-31', status:'active'},
  {memberUid:'memberA', membershipYear:2027, membershipPlan:'annual_standard',
    startDate:'2027-01-01', expiryDate:'2027-12-31', status:'scheduled'},
];
context.financeRecords = [
  {memberId:'memberA', type:'annual', membershipYear:2027,
    membershipExpiry:'2027-12-31', date:'2026-11-10', status:'active'},
];

assert.strictEqual(context._membershipUiYear('2026-11-10'), 2026);
assert.strictEqual(context._membershipUiYear('2027-01-01'), 2027);
assert.strictEqual(context._membershipUiYear('2028-01-01'), 2028);

const in2026 = context._calcMemberFeeStatus(member, '2026-11-10');
assert.notStrictEqual(in2026.status, 'none');
assert.strictEqual(in2026.expStr, '2026-12-31');
assert(in2026.statusLabel.includes('2027 已續會待生效'));
assert.strictEqual(context._memberManagementPlan(member, '2026-11-10'), 'annual_standard');

const in2027 = context._calcMemberFeeStatus(member, '2027-01-01');
assert.notStrictEqual(in2027.status, 'none');
assert.strictEqual(in2027.expStr, '2027-12-31');
assert.strictEqual(context._memberManagementPlan(member, '2027-01-01'), 'annual_standard');

const in2028 = context._calcMemberFeeStatus(member, '2028-01-01');
assert.strictEqual(in2028.status, 'none');
assert(in2028.statusLabel.includes('2028 年度待續會'));

context.membershipPeriodsCache = [];
assert.strictEqual(context._calcMemberFeeStatus(member, '2026-11-10').status, 'none');
context.financeRecords.push({memberId:'memberA', type:'annual', membershipYear:2026,
  membershipExpiry:'2026-12-31', date:'2026-06-01', status:'active'});
assert.notStrictEqual(context._calcMemberFeeStatus(member, '2026-11-10').status, 'none');
assert.strictEqual(context._calcMemberFeeStatus(member, '2027-01-01').status, 'none');

console.log('member management year tests passed');
