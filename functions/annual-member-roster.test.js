'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function extractFunction(text, name) {
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert(start >= 0, `${name} not found`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}' && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

const context = {financeRecords: [], _annualRosterYear: 2026, _annualRosterPlanFilter: ''};
vm.createContext(context);
vm.runInContext([
  extractFunction(frontend, '_annualRosterYears'),
  extractFunction(frontend, '_memberExistedByYear'),
  extractFunction(frontend, '_annualRosterStatus'),
  extractFunction(frontend, '_buildAnnualRosterRows'),
  extractFunction(frontend, '_currentMemberStats'),
  extractFunction(frontend, '_annualRosterPlanOptionsHtml'),
].join('\n'), context);

const planOptions2026 = context._annualRosterPlanOptionsHtml();
assert(planOptions2026.includes('年費會員'));
assert(!planOptions2026.includes('銀爸銀媽'));
context._annualRosterYear = 2027;
const planOptions2027 = context._annualRosterPlanOptionsHtml();
assert(planOptions2027.includes('一般年費'));
assert(planOptions2027.includes('銀爸銀媽'));

const currentStats = context._currentMemberStats({
  annualA: {status:'approved',membershipType:'annual'},
  seniorA: {status:'approved',membershipType:'annual',membershipPlan:'annual_senior'},
  monthlyA: {status:'approved',membershipType:'monthly'},
  deletedA: {status:'deleted',membershipType:'monthly'},
  mergedA: {status:'approved',membershipType:'annual',mergedInto:'annualA'},
});
assert.strictEqual(JSON.stringify(currentStats), JSON.stringify({total:3,annual:2,monthly:1,senior:1}));

context.membershipPeriodsCache = [{membershipYear: 2040}];
const rosterYears = Array.from(context._annualRosterYears());
assert.strictEqual(rosterYears[0], 2026);
assert(rosterYears.includes(2036));
assert.strictEqual(rosterYears[rosterYears.length - 1], 2040);

const members = {
  annualA: {realName: '一般會員', status: 'approved', createdAt: '2026-02-01'},
  monthlyA: {realName: '月費會員', status: 'approved', createdAt: '2026-03-01'},
  resignedA: {realName: '離會會員', status: 'approved', createdAt: '2026-04-01'},
  blockedA: {realName: '封鎖會員', status: 'blocked', createdAt: '2026-05-01'},
  renewalA: {realName: '待續會員', status: 'approved', createdAt: '2026-06-01'},
  missingA: {realName: '待補建會員', status: 'approved', createdAt: '2026-07-01'},
  invalidA: {realName: '無效繳費會員', status: 'approved', createdAt: '2026-07-01'},
  futureA: {realName: '未來會員', status: 'approved', createdAt: '2027-02-01'},
  pendingA: {realName: '待審核帳號', status: 'pending', createdAt: '2026-08-01'},
};

const periods = [
  {memberUid: 'annualA', memberName: '一般會員', membershipYear: 2026,
    membershipPlan: 'annual_standard', membershipPlanLabel: '一般年費',
    expiryDate: '2026-12-31', status: 'expired'},
  {memberUid: 'annualA', memberName: '一般會員', membershipYear: 2027,
    membershipPlan: 'annual_senior', membershipPlanLabel: '銀爸銀媽',
    startDate: '2027-01-01', expiryDate: '2027-12-31', status: 'scheduled'},
  {memberUid: 'monthlyA', membershipYear: 2026, membershipPlan: 'monthly',
    membershipPlanLabel: '月費', expiryDate: '2026-08-31', status: 'expired'},
  {memberUid: 'monthlyA', membershipYear: 2026, membershipPlan: 'monthly',
    membershipPlanLabel: '月費', expiryDate: '2026-10-31', status: 'expired'},
  {memberUid: 'resignedA', membershipYear: 2026,
    membershipPlan: 'annual_standard', expiryDate: '2026-12-31', status: 'resigned'},
  {memberUid: 'blockedA', membershipYear: 2026,
    membershipPlan: 'annual_standard', expiryDate: '2026-12-31', status: 'active'},
  {memberUid: 'renewalA', membershipYear: 2026,
    membershipPlan: 'annual_standard', expiryDate: '2026-12-31', status: 'expired'},
  {memberUid: 'renewalA', memberName: '待續會員', membershipYear: 2027,
    membershipType: 'annual', membershipPlan: 'annual_unclassified',
    membershipPlanLabel: '年費會員（待分類）', startDate: '2027-01-01',
    expiryDate: '2027-12-31', status: 'scheduled', membershipOrigin: 'renewal'},
  {memberUid: 'annualA', memberName: '一般會員', membershipYear: 2028,
    membershipType: 'annual', membershipPlan: 'annual_standard',
    membershipPlanLabel: '一般年費', startDate: '2028-01-01',
    expiryDate: '2028-12-31', status: 'scheduled', membershipOrigin: 'renewal'},
  {memberUid: 'annualA', memberName: '一般會員', membershipYear: 2029,
    membershipType: 'annual', membershipPlan: 'annual_standard',
    membershipPlanLabel: '一般年費', startDate: '2029-01-01',
    expiryDate: '2029-12-31', status: 'scheduled', membershipOrigin: 'renewal'},
];

const rows2026 = context._buildAnnualRosterRows(2026, periods, members);
assert.strictEqual(rows2026.filter((row) => row.memberUid === 'monthlyA').length, 1);
assert.strictEqual(rows2026.find((row) => row.memberUid === 'monthlyA').expiryDate, '2026-10-31');
assert.strictEqual(rows2026.find((row) => row.memberUid === 'annualA').membershipPlan, 'annual_standard');
assert.strictEqual(rows2026.find((row) => row.memberUid === 'resignedA').status, 'resigned');
assert.strictEqual(rows2026.find((row) => row.memberUid === 'blockedA').status, 'qualified');
assert.strictEqual(rows2026.find((row) => row.memberUid === 'missingA').status, 'missing');
assert.strictEqual(rows2026.find((row) => row.memberUid === 'missingA').statusLabel, '尚無年度紀錄');
assert.strictEqual(rows2026.some((row) => row.memberUid === 'futureA'), false);
assert.strictEqual(rows2026.some((row) => row.memberUid === 'pendingA'), false);

context.financeRecords = [{
  memberId: 'missingA', type: 'annual', membershipYear: 2027,
  membershipExpiry: '2027-12-31', status: 'active', amount: 1000,
}, {
  memberId: 'renewalA', type: 'annual', membershipYear: 2027,
  membershipExpiry: '2027-12-31', status: 'active', amount: 1000,
}, {
  memberId: 'invalidA', type: 'annual', membershipYear: 2027,
  membershipExpiry: '2027-12-31', status: 'void', amount: 1000,
}, {
  memberId: 'invalidA', type: 'annual', membershipYear: 2028,
  membershipExpiry: '2028-12-31', status: 'active', amount: 1000,
}];

const rows2027 = context._buildAnnualRosterRows(2027, periods, members, '2026-11-12');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'annualA').membershipPlan, 'annual_senior');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'annualA').status, 'scheduled');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'renewalA').statusLabel, '已繳費・待生效');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'renewalA').membershipOrigin, 'renewal');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').statusLabel, '尚無年度紀錄');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').status, 'missing');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').hasPaymentWithoutPeriod, true);
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').paymentRecordCount, 1);
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').paymentDerived, false);
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').membershipOrigin, '');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'missingA').expiryDate, '');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'invalidA').status, 'missing');
assert.strictEqual(rows2027.find((row) => row.memberUid === 'invalidA').paymentDerived, false);

context.financeRecords = context.financeRecords.filter((record) => record.memberId !== 'renewalA');
const periodsWithoutRenewal2027 = periods.filter((period) => !(
  period.memberUid === 'renewalA' && period.membershipYear === 2027
));
const rows2027WithDecision = context._buildAnnualRosterRows(
  2027, periodsWithoutRenewal2027, members, null, [{
    memberUid: 'renewalA', membershipYear: 2027,
    status: 'not_joining', note: '本年度暫不參加',
  }],
);
assert.strictEqual(
  rows2027WithDecision.find((row) => row.memberUid === 'renewalA').status,
  'not_joining',
);
assert.strictEqual(
  rows2027WithDecision.find((row) => row.memberUid === 'renewalA').statusLabel,
  '今年不加入',
);
const rows2028AfterDecision = context._buildAnnualRosterRows(
  2028, periodsWithoutRenewal2027, members, null, [{
    memberUid: 'renewalA', membershipYear: 2027, status: 'not_joining',
  }],
);
assert.strictEqual(
  rows2028AfterDecision.find((row) => row.memberUid === 'renewalA').status,
  'pending',
);

const rows2027Active = context._buildAnnualRosterRows(2027, periods, members, '2027-01-01');
assert.strictEqual(rows2027Active.find((row) => row.memberUid === 'annualA').status, 'qualified');
assert.strictEqual(rows2027Active.find((row) => row.memberUid === 'missingA').status, 'missing');
assert.strictEqual(rows2027Active.find((row) => row.memberUid === 'missingA').statusLabel, '尚無年度紀錄');
const rows2028Scheduled = context._buildAnnualRosterRows(2028, periods, members, '2027-12-31');
assert.strictEqual(rows2028Scheduled.find((row) => row.memberUid === 'annualA').status, 'scheduled');
const rows2028Active = context._buildAnnualRosterRows(2028, periods, members, '2028-01-01');
assert.strictEqual(rows2028Active.find((row) => row.memberUid === 'annualA').status, 'qualified');
const rows2029Scheduled = context._buildAnnualRosterRows(2029, periods, members, '2028-12-31');
assert.strictEqual(rows2029Scheduled.find((row) => row.memberUid === 'annualA').status, 'scheduled');
const rows2029Active = context._buildAnnualRosterRows(2029, periods, members, '2029-01-01');
assert.strictEqual(rows2029Active.find((row) => row.memberUid === 'annualA').status, 'qualified');
const rows2026Historical = context._buildAnnualRosterRows(2026, periods, members, '2028-01-01');
assert.strictEqual(rows2026Historical.find((row) => row.memberUid === 'annualA').status, 'qualified');
assert.strictEqual(rows2026Historical.filter((row) => row.memberUid === 'monthlyA').length, 1);

context.financeRecords.push({memberId:'missingA',type:'annual',membershipYear:2026,
  membershipExpiry:'2026-12-31',status:'active'});
const rows2026NoFinanceFallback = context._buildAnnualRosterRows(2026, periods, members, '2026-11-12');
assert.strictEqual(rows2026NoFinanceFallback.find((row) => row.memberUid === 'missingA').status, 'missing');
assert.strictEqual(rows2026NoFinanceFallback.find((row) => row.memberUid === 'missingA').paymentDerived, false);

const rosterFunction = extractFunction(frontend, '_buildAnnualRosterRows');
assert(rosterFunction.includes('var rosterPeriods=memberPeriods'));
assert(!rosterFunction.includes("source:'financial_record_preview'"));
assert(!rosterFunction.includes('member.membershipExpiry'));
assert(frontend.includes('aria-label="會員年度"'));
assert(frontend.includes('markMembershipYearNotJoining'));
assert(frontend.includes('revokeMembershipYearNotJoining'));
assert(frontend.includes('>今年不加入</option>'));
assert(frontend.includes('今年不加入（'));
assert(frontend.includes("{key:'manage',label:'會員管理'}"));
assert(frontend.includes("{key:'roster',label:'年度會員名冊'}"));
assert(frontend.includes("{key:'stats',label:'會員統計'}"));
assert(frontend.includes('ANNUAL_ROSTER_PAGE_SIZE=10'));
assert(frontend.includes("_callBookingFunction('getAnnualMemberRosterExport'"));
assert(frontend.includes('annualRosterTable'));
assert(frontend.includes("_memberStatCard('總會員',currentStats.total"));
assert(frontend.includes("_memberStatCard('年費會員',currentStats.annual"));
assert(frontend.includes("_memberStatCard('月費會員',currentStats.monthly"));
assert(frontend.includes("_memberStatCard('銀爸銀媽',currentStats.senior"));
assert(frontend.includes("Number(_annualRosterYear)>=2027?_memberStatCard('銀爸銀媽'"));
assert(frontend.includes("supportsSenior=Number(_annualRosterYear)>=2027"));
assert(!frontend.includes('id="memberRoleSwitcher"'));
assert(!frontend.includes('_memberManageView'));
assert(!frontend.includes('function _renderAnnualRosterTab('));

console.log('annual member roster tests passed');
