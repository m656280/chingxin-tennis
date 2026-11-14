'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const frontend = fs.readFileSync(require.resolve('../index.html'), 'utf8');

function extractFunction(text, name) {
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

const context = {
  crypto,
  MEMBERSHIP_PLANS: new Set(['annual_standard', 'annual_senior', 'monthly']),
};
vm.createContext(context);
vm.runInContext([
  extractFunction(source, 'cleanString'),
  extractFunction(source, 'isIsoDate'),
  extractFunction(source, 'addMembershipMonths'),
  extractFunction(source, 'membershipTypeForPlan'),
  extractFunction(source, 'membershipPlanAllowedForYear'),
  extractFunction(source, 'membershipPeriodStatus'),
  extractFunction(source, 'membershipPeriodId'),
  extractFunction(source, 'buildMembershipRenewalSpec'),
  extractFunction(source, 'renewalOperationDocId'),
].join('\n'), context);

const renewal2027 = context.buildMembershipRenewalSpec({
  membershipPlan: 'annual_standard',
  membershipYear: 2027,
  accountingYear: 2027,
  paymentDate: '2026-11-09',
}, '2026-11-09');
assert.strictEqual(renewal2027.paymentDate, '2026-11-09');
assert.strictEqual(renewal2027.accountingDate, '2027-01-01');
assert.strictEqual(renewal2027.accountingYear, 2027);
assert.strictEqual(renewal2027.membershipStartDate, '2027-01-01');
assert.strictEqual(renewal2027.membershipExpiry, '2027-12-31');
assert.strictEqual(renewal2027.status, 'scheduled');

const active2027 = context.buildMembershipRenewalSpec({
  membershipPlan: 'annual_senior',
  membershipYear: 2027,
  accountingYear: 2027,
  paymentDate: '2027-01-01',
}, '2027-01-01');
assert.strictEqual(active2027.status, 'active');
assert.strictEqual(active2027.membershipType, 'annual');
assert.throws(() => context.buildMembershipRenewalSpec({
  membershipPlan: 'annual_senior',
  membershipYear: 2026,
  accountingYear: 2026,
  paymentDate: '2026-01-01',
}, '2026-01-01'), /membership_plan_not_available_for_year/);

const monthly2027 = context.buildMembershipRenewalSpec({
  membershipPlan: 'monthly',
  membershipYear: 2027,
  accountingYear: 2027,
  accountingDate: '2027-01-01',
  paymentDate: '2026-12-20',
  periodMonths: 2,
}, '2026-12-20');
assert.strictEqual(monthly2027.accountingDate, '2027-01-01');
assert.strictEqual(monthly2027.membershipExpiry, '2027-03-01');
assert.strictEqual(monthly2027.status, 'scheduled');

assert.throws(() => context.buildMembershipRenewalSpec({
  membershipPlan: 'monthly', membershipYear: 2027,
  accountingYear: 2027, accountingDate: '2026-12-01',
  paymentDate: '2026-11-09', periodMonths: 1,
}, '2026-11-09'), /accounting_year_mismatch/);
assert.throws(() => context.buildMembershipRenewalSpec({
  membershipPlan: 'annual_standard', membershipYear: 2027,
  accountingYear: 2026, paymentDate: '2026-11-09',
}, '2026-11-09'), /membership_accounting_year_mismatch/);
assert.throws(() => context.buildMembershipRenewalSpec({
  membershipPlan: 'monthly', membershipYear: 2028,
  accountingYear: 2027, accountingDate: '2027-01-01',
  paymentDate: '2026-12-20', periodMonths: 1,
}, '2026-12-20'), /membership_accounting_year_mismatch/);

assert.strictEqual(
  context.renewalOperationDocId('OWNER', 'REQUEST'),
  context.renewalOperationDocId('OWNER', 'REQUEST'),
);
assert.notStrictEqual(
  context.renewalOperationDocId('OWNER', 'REQUEST'),
  context.renewalOperationDocId('OWNER', 'REQUEST_2'),
);
assert.strictEqual(
  context.membershipPeriodId('MEMBER', renewal2027),
  context.membershipPeriodId('MEMBER', renewal2027),
);
assert.strictEqual(
  context.membershipPeriodId('MEMBER', monthly2027),
  context.membershipPeriodId('MEMBER', Object.assign({}, monthly2027, {
    membershipStartDate: '2027-04-01', membershipExpiry: '2027-05-01',
  })),
);
assert.notStrictEqual(
  context.membershipPeriodId('MEMBER', monthly2027),
  context.membershipPeriodId('MEMBER', Object.assign({}, monthly2027, {
    membershipYear: 2028,
  })),
);

const frontContext = {};
frontContext._renderMonthlyBalance = () => '';
frontContext._renderExpiringSoon = () => '';
vm.createContext(frontContext);
vm.runInContext([
  extractFunction(frontend, '_financeAccountingDate'),
  extractFunction(frontend, '_inExportRange'),
  extractFunction(frontend, '_financeMembershipPlanUi'),
  extractFunction(frontend, '_financeMemberChoices'),
  extractFunction(frontend, '_statCard'),
  extractFunction(frontend, '_renderFinOverview'),
].join('\n'), frontContext);
const prepaid = {
  date: '2026-11-09', accountingDate: '2027-01-01', year: 2027,
  amount: 2100, status: 'active', type: 'annual',
};
assert.strictEqual(frontContext._financeAccountingDate(prepaid), '2027-01-01');
assert.strictEqual(frontContext._inExportRange(
  prepaid, '2026-01-01', '2026-12-31'), false);
assert.strictEqual(frontContext._inExportRange(
  prepaid, '2027-01-01', '2027-12-31'), true);
assert.strictEqual(frontContext._financeAccountingDate({
  date: '2026-08-14', year: 2026,
}), '2026-08-14');

const records = [
  prepaid,
  {date: '2027-02-01', amount: 800, status: 'void', type: 'annual'},
  {date: '2026-08-14', amount: 600, status: 'active', type: 'day_pass'},
];
function annualTotal(year) {
  return records.filter((record) =>
    frontContext._financeAccountingDate(record).slice(0, 4) === String(year) &&
    (record.status || 'active') !== 'void')
    .reduce((sum, record) => sum + record.amount, 0);
}
assert.strictEqual(annualTotal(2026), 600);
assert.strictEqual(annualTotal(2027), 2100);

const typeSelect = frontend.match(/<select class="formSelect" id="finFormType"[\s\S]*?<\/select>/);
assert(typeSelect, 'finance type select missing');
assert.deepStrictEqual(
  Array.from(typeSelect[0].matchAll(/<option value="([^"]+)">/g), (match) => match[1]),
  ['annual', 'monthly', 'day_pass', 'donate', 'expense'],
);
assert(!frontend.includes('id="finFormAccountingYearRow"'));
assert(frontend.includes('<label class="formLabel">所屬年度</label>'));
const annual2026Ui = frontContext._financeMembershipPlanUi('annual', 2026);
assert.strictEqual(annual2026Ui.visible, false);
assert(!annual2026Ui.options.includes('annual_senior'));
const annual2027Ui = frontContext._financeMembershipPlanUi('annual', 2027);
assert.strictEqual(annual2027Ui.visible, true);
assert(annual2027Ui.options.includes('annual_standard'));
assert(annual2027Ui.options.includes('annual_senior'));
assert.strictEqual(frontContext._financeMembershipPlanUi('annual', 2029).visible, true);
assert.strictEqual(frontContext._financeMembershipPlanUi('monthly', 2027).defaultValue, 'monthly');
['day_pass', 'donate', 'expense'].forEach((type) => {
  assert.strictEqual(frontContext._financeMembershipPlanUi(type, 2027).visible, false);
});
const memberChoices = frontContext._financeMemberChoices({
  same: {uid:'same', realName:'王小美', displayName:'王小美', status:'approved'},
  nickname: {uid:'nickname', realName:'陸貞如', displayName:'Lu', status:'approved'},
  notRenewed: {uid:'notRenewed', realName:'待續會員', displayName:'Renew', status:'approved'},
  deleted: {uid:'deleted', realName:'離會會員', displayName:'Gone', status:'deleted'},
  resigned: {uid:'resigned', realName:'年度離會', displayName:'Left', status:'approved'},
}, [{memberUid:'resigned', membershipYear:2027, status:'resigned'}], 2027, '', '陸');
assert.strictEqual(memberChoices.length, 1);
assert.strictEqual(memberChoices[0].uid, 'nickname');
assert.strictEqual(memberChoices[0].label, '陸貞如（Lu）');
const allChoices = frontContext._financeMemberChoices({
  notRenewed: {uid:'notRenewed', realName:'待續會員', status:'approved'},
  deleted: {uid:'deleted', realName:'離會會員', status:'deleted'},
  resigned: {uid:'resigned', realName:'年度離會', status:'approved'},
}, [{memberUid:'resigned', membershipYear:2027, status:'resigned'}], 2027, '', '');
assert.deepStrictEqual(Array.from(allChoices, (choice) => choice.uid), ['notRenewed']);
assert.strictEqual(frontContext._financeMemberChoices({
  deleted: {uid:'deleted', realName:'離會會員', status:'deleted'},
}, [], 2027, 'deleted', '')[0].label, '[已離會] 離會會員');
const sameNameChoice = frontContext._financeMemberChoices({
  same: {uid:'same', realName:'王小美', displayName:'王小美', status:'approved'},
}, [], 2027, '', '')[0];
assert.strictEqual(sameNameChoice.label, '王小美');
const renewalChoices = frontContext._financeMemberChoices({
  notRenewed: {uid:'notRenewed', realName:'待續會員', displayName:'Renew', status:'approved'},
}, [], 2027, '', 'Renew');
assert.strictEqual(renewalChoices.length, 1);
assert.strictEqual(frontContext._financeMemberChoices({
  deleted: {uid:'deleted', realName:'離會會員', status:'deleted'},
}, [], 2027, '', '').length, 0);
[
  "annual:'年費'", "monthly:'月費'", "day_pass:'臨打'",
  "donate:'抖內'", "expense:'支出'",
].forEach((label) => assert(frontend.includes(label), `${label} report label missing`));
assert(source.includes('type: spec.membershipType'));
assert(source.includes('membershipPlan: spec.membershipPlan'));
assert(source.includes('membershipPlanAllowedForYear('));
const emptyYearOverview = frontContext._renderFinOverview(
  [], 0, 0, 0, 0, 0, 0, 0,
  (amount) => `NT$ ${amount.toLocaleString()}`,
);
['年費', '月費', '臨打', '抖內', '支出'].forEach((label) => {
  assert(emptyYearOverview.includes(label), `${label} missing from empty year`);
});
assert.strictEqual((emptyYearOverview.match(/NT\$ 0/g) || []).length >= 6, true);
[
  'function exportFinancePDF()', 'function exportFinanceCSV()',
  'function openFinDupCheck()', 'function _renderMonthlyBalance(',
].forEach((feature) => assert(frontend.includes(feature), `${feature} missing`));

assert(source.includes("bookingDb.collection('membershipRenewalOperations')"));
assert(source.includes('bookingDb.runTransaction(async (transaction)'));
assert(source.includes("bookingDb.collection('membershipPeriods')"));
assert(source.includes("bookingDb.collection('membershipYearDecisions')"));
assert(source.includes('markMembershipYearNotJoining'));
assert(source.includes('revokeMembershipYearNotJoining'));
assert(source.includes('renewalOperationId: operationId'));
assert(source.includes('financialRecordIds: admin.firestore.FieldValue.arrayUnion'));
assert(source.includes("exports.rollbackMembershipPeriodBackfill = onCall"));
assert(source.includes("'annual_unclassified'"));
assert(source.includes("historicalSnapshotSource: 'members'"));
assert(source.includes('mixedAnnualMonthly: sourceTypes.size > 1'));
assert(source.includes('suspectedDuplicate,'));
assert(source.includes("member.status === 'deleted' ? 'resigned'"));
assert(!source.includes(".doc(`legacy_${recordId}`)"));
assert(source.includes('membershipExpiryForBooking('));
assert(source.includes(".where('memberUid', '==', memberUid)"));
assert(frontend.includes('accountingDate || date'));

console.log('membership renewal tests passed');
