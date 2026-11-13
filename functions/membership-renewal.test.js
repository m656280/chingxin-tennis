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
vm.createContext(frontContext);
vm.runInContext([
  extractFunction(frontend, '_financeAccountingDate'),
  extractFunction(frontend, '_inExportRange'),
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
