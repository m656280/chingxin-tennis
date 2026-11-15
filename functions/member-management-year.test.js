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
  usersCache: {},
  _esc: (value) => String(value || ''),
};
vm.createContext(context);
vm.runInContext([
  extractFunction('_effectiveFinanceMembershipExpiry'),
  extractFunction('_membershipUiYear'),
  extractFunction('_memberYearPeriods'),
  extractFunction('_memberManagementPeriodState'),
  extractFunction('_financeRecordMembershipYear'),
  extractFunction('_calcMemberFeeStatus'),
  extractFunction('_membershipDateKey'),
  extractFunction('_financeYearFeeStatus'),
  extractFunction('_monthlyExpiryReminderItems'),
  extractFunction('_monthlyExpiryReminderHtml'),
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

context.membershipPeriodsCache = [
  {memberUid:'memberA', membershipYear:2026, membershipPlan:'monthly',
    membershipType:'monthly', startDate:'2026-10-24', expiryDate:'2026-11-24',
    status:'active'},
  {memberUid:'memberA', membershipYear:2027, membershipPlan:'annual_standard',
    membershipType:'annual', startDate:'2027-01-01', expiryDate:'2027-12-31',
    status:'scheduled'},
];
const selected2027 = context._financeYearFeeStatus(
  member, 2027, '2026-11-14');
assert.strictEqual(selected2027.status, 'scheduled');
assert.strictEqual(selected2027.expStr, '2027-12-31');
assert(!selected2027.statusLabel.includes('2026'));
assert.strictEqual(context._financeYearFeeStatus(
  {userId:'notRenewed'}, 2027, '2026-11-14').status, 'unpaid');
assert.strictEqual(context._financeYearFeeStatus(
  {userId:'notRenewed'}, 2028, '2027-11-14').status, 'unpaid');
const selected2026 = context._financeYearFeeStatus(
  member, 2026, '2026-11-14');
assert.strictEqual(selected2026.status, 'expiring');
assert.strictEqual(selected2026.expStr, '2026-11-24');

const monthlyMember = {userId:'monthlyMember', realName:'月費會員', status:'approved'};
const resignedMember = {userId:'resignedMember', realName:'已離會會員', status:'deleted'};
context.membershipPeriodsCache = [
  {memberUid:'monthlyMember', membershipYear:2026, membershipPlan:'monthly',
    membershipType:'monthly', startDate:'2026-10-01', expiryDate:'2026-11-24', status:'expired'},
  {memberUid:'monthlyMember', membershipYear:2027, membershipPlan:'monthly',
    membershipType:'monthly', startDate:'2027-01-01', expiryDate:'2027-02-28', status:'active'},
  {memberUid:'monthlyMember', membershipYear:2028, membershipPlan:'monthly',
    membershipType:'monthly', startDate:'2028-01-01', expiryDate:'2028-03-31', status:'active'},
  {memberUid:'resignedMember', membershipYear:2027, membershipPlan:'monthly',
    membershipType:'monthly', startDate:'2027-01-01', expiryDate:'2027-01-10', status:'resigned'},
];

assert.strictEqual(context._financeYearFeeStatus(
  monthlyMember, 2026, '2026-11-01').status, 'paid');
assert.strictEqual(context._financeYearFeeStatus(
  monthlyMember, 2026, '2026-11-14').status, 'expiring');
assert.strictEqual(context._financeYearFeeStatus(
  monthlyMember, 2026, '2026-11-30').status, 'overdue');
const overdue2026 = context._monthlyExpiryReminderItems(
  2026, [monthlyMember, resignedMember], '2026-11-30');
assert.strictEqual(overdue2026.length, 1);
assert(overdue2026[0].feeStatus.statusLabel.includes('已到期 6 天'));
const overdueHtml = context._monthlyExpiryReminderHtml(
  2026, [monthlyMember, resignedMember], '2026-11-30');
assert(overdueHtml.includes('2026 月費到期提醒（1）'));
assert(overdueHtml.includes('已到期 6 天'));
assert(overdueHtml.includes('openFinanceFormForMember'));
assert(!overdueHtml.includes('已離會會員'));

assert.strictEqual(context._monthlyExpiryReminderItems(
  2027, [monthlyMember], '2026-12-20').length, 0);
assert.strictEqual(context._monthlyExpiryReminderItems(
  2027, [monthlyMember], '2027-02-20').length, 1);
assert.strictEqual(context._monthlyExpiryReminderItems(
  2028, [monthlyMember], '2028-03-20').length, 1);

context.membershipPeriodsCache[0] = Object.assign({}, context.membershipPeriodsCache[0], {
  expiryDate:'2026-12-31', status:'active',
});
assert.strictEqual(context._monthlyExpiryReminderItems(
  2026, [monthlyMember], '2026-11-30').length, 0);
assert(frontend.includes('_monthlyExpiryReminderHtml(_annualRosterYear,Object.values(usersCache))'));

console.log('member management year tests passed');
