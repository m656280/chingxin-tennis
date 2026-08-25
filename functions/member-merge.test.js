'use strict';

const assert = require('assert');
const crypto = require('crypto');
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

const context = {crypto};
vm.createContext(context);
vm.runInContext([
  extractFunction('cleanString'),
  extractFunction('normaliseMemberName'),
  extractFunction('normaliseExpiryDate'),
  extractFunction('canonicalMergeValue'),
  extractFunction('memberMergeHash'),
  extractFunction('bookingContainsMemberUid'),
  extractFunction('replaceMemberUidInBooking'),
  extractFunction('memberMergeMembership'),
  extractFunction('memberMergeSnapshotMatches'),
  extractFunction('memberMergeFinanceKey'),
  extractFunction('assessMemberMergeState'),
  extractFunction('memberMergeChange'),
  extractFunction('buildMemberMergeChanges'),
].join('\n'), context);

function item(path, data) {
  return {path, id: path.split('/').pop(), data};
}

const line = {
  uid: 'LINE_UID', realName: '戴沛親', displayName: 'Mary',
  role: 'member', status: 'approved', memberSource: 'line', approved: true,
};
const manual = {
  uid: 'MANUAL_UID', realName: '戴沛親', displayName: '戴沛親',
  role: 'member', status: 'approved', memberSource: 'manual', approved: true,
  membershipType: 'annual', membershipExpiry: '2026-12-31',
  expireDate: '2026-12-31',
};
const state = {
  candidate: item('duplicateMemberCandidates/CANDIDATE', {
    status: 'pending', lineMemberUid: 'LINE_UID', manualMemberUid: 'MANUAL_UID',
    lineMember: Object.assign({}, line), manualMember: Object.assign({}, manual),
  }),
  lineMember: item('members/LINE_UID', line),
  manualMember: item('members/MANUAL_UID', manual),
  manualFinancialRecords: [item('financialRecords/FINANCE_1', {
    memberId: 'MANUAL_UID', type: 'annual', status: 'active',
    membershipYear: 2026, amount: 3600, date: '2026-05-25',
    membershipExpiry: '2026-12-31',
  })],
  lineFinancialRecords: [],
  bookings: [],
  manualViolations: [],
  lineViolations: [],
  manualSummary: null,
  lineSummary: null,
  coachMembers: [],
  notifications: [],
  extensionRequests: [],
};

const preview = context.assessMemberMergeState(state);
assert.strictEqual(preview.canMerge, true);
assert.strictEqual(preview.effectiveMembership.membershipType, 'annual');
assert.strictEqual(preview.effectiveMembership.membershipExpiry, '2026-12-31');
assert.strictEqual(preview.counts.financialRecords, 1);
assert.strictEqual(preview.counts.bookings, 0);
assert.strictEqual(preview.counts.violations, 0);
assert.strictEqual(preview.counts.coachStudents, 0);
assert.strictEqual(preview.previewHash.length, 64);
const changes = context.buildMemberMergeChanges(
  state, preview, {uid: 'OWNER_UID', name: 'Owner'}, 'OPERATION_ID',
  '2026-08-25T00:00:00.000Z',
);
assert.strictEqual(changes.length, 4);
const financeChange = changes.find((change) =>
  change.path === 'financialRecords/FINANCE_1');
assert(financeChange);
assert.strictEqual(financeChange.after.memberId, 'LINE_UID');
assert.deepStrictEqual(
  Object.keys(financeChange.after).filter((key) =>
    financeChange.after[key] !== financeChange.before[key]),
  ['memberId'],
);
const manualChange = changes.find((change) =>
  change.path === 'members/MANUAL_UID');
assert.strictEqual(manualChange.after.status, 'merged');
assert.strictEqual(manualChange.after.mergedInto, 'LINE_UID');
assert.strictEqual(manualChange.after.mergeOperationId, 'OPERATION_ID');

const booking = {
  createdBy: 'MANUAL_UID', players: ['MANUAL_UID', 'OTHER'],
  students: ['MANUAL_UID'], coachId: 'MANUAL_UID',
  attendance: {MANUAL_UID: {present: true}},
};
const replaced = context.replaceMemberUidInBooking(
  booking, 'MANUAL_UID', 'LINE_UID');
assert.strictEqual(replaced.createdBy, 'LINE_UID');
assert.deepStrictEqual(Array.from(replaced.players), ['LINE_UID', 'OTHER']);
assert.deepStrictEqual(Array.from(replaced.students), ['LINE_UID']);
assert.strictEqual(replaced.coachId, 'LINE_UID');
assert(replaced.attendance.LINE_UID);
assert(!replaced.attendance.MANUAL_UID);

const nameDrift = JSON.parse(JSON.stringify(state));
nameDrift.manualMember.data.realName = '不同姓名';
assert.strictEqual(context.assessMemberMergeState(nameDrift).canMerge, false);

const roleConflict = JSON.parse(JSON.stringify(state));
roleConflict.manualMember.data.role = 'admin';
assert(context.assessMemberMergeState(roleConflict).blockers.some((message) =>
  message.includes('角色不一致')));

const duplicateBooking = JSON.parse(JSON.stringify(state));
duplicateBooking.bookings = [item('bookings/BOTH', {
  createdBy: 'LINE_UID', players: ['LINE_UID', 'MANUAL_UID'],
})];
assert(context.assessMemberMergeState(duplicateBooking).blockers.some((message) =>
  message.includes('同時包含兩個 UID')));

const financeConflict = JSON.parse(JSON.stringify(state));
financeConflict.lineFinancialRecords = [item('financialRecords/LINE_FINANCE', {
  memberId: 'LINE_UID', type: 'annual', status: 'active',
  membershipYear: 2026, membershipExpiry: '2026-12-31',
})];
assert(context.assessMemberMergeState(financeConflict).blockers.some((message) =>
  message.includes('財務帳期衝突')));

const extensionConflict = JSON.parse(JSON.stringify(state));
extensionConflict.extensionRequests = [item(
  'bookingExtensionRequests/MANUAL_UID_2026-08-25',
  {requesterUid: 'MANUAL_UID'},
)];
assert(context.assessMemberMergeState(extensionConflict).blockers.some((message) =>
  message.includes('加時申請')));

[
  'exports.previewMemberMerge = onCall',
  'exports.executeMemberMerge = onCall',
  'exports.rollbackMemberMerge = onCall',
  'bookingDb.runTransaction',
  'assessment.previewHash !== previewHash',
  "status: 'merged'",
  'mergedInto: lineUid',
  'memberMergeOperations',
  "Object.assign({}, item.data, {memberId: lineUid})",
].forEach((text) => assert(source.includes(text), `backend wiring missing: ${text}`));

[
  'function openMemberMergePreview',
  "httpsCallable('previewMemberMerge')",
  'function executeMemberMergeFromPreview',
  "httpsCallable('executeMemberMerge')",
  '此畫面只是預覽',
  "memberData.status==='merged'||memberData.mergedInto",
].forEach((text) => assert(frontend.includes(text), `frontend wiring missing: ${text}`));

assert(rules.includes('match /memberMergeOperations/{operationId}'));
assert(rules.includes("request.resource.data.status != 'merged'"));
assert(rules.includes("'mergedInto', 'mergedAt', 'mergedByUid'"));

console.log('PASS 戴沛親 fixture transfers annual membership and one finance link');
console.log('PASS booking UID fields and attendance key are safely reassigned');
console.log('PASS name, role, duplicate booking, finance, and extension blockers');
console.log('PASS preview hash, Transaction, rollback, Owner UI, and Rules wiring');
