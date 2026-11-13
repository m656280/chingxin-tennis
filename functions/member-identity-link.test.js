'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const lineauth = fs.readFileSync(require.resolve('../lineauth/index.js'), 'utf8');
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

const fakeDocs = new Map();
const fakeDb = {
  collection(name) {
    return {
      doc(id) {
        const path = `${name}/${id}`;
        return {
          path,
          async get() {
            const data = fakeDocs.get(path);
            return {exists: data != null, data: () => data};
          },
        };
      },
    };
  },
};
class FakeHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const context = {crypto, bookingDb: fakeDb, HttpsError: FakeHttpsError};
vm.createContext(context);
vm.runInContext([
  extractFunction('cleanString'),
  extractFunction('memberIdentityLinkRef'),
  extractFunction('resolveMemberIdentity').replace(/^function /, 'async function '),
  extractFunction('normaliseMemberName'),
  extractFunction('normaliseExpiryDate'),
  extractFunction('duplicateMemberPairId'),
  extractFunction('canonicalMergeValue'),
  extractFunction('memberMergeHash'),
  extractFunction('bookingContainsMemberUid'),
  extractFunction('replaceMemberUidInBooking'),
  extractFunction('memberMergeMembership'),
  extractFunction('memberMergeSnapshotDiffValue'),
  extractFunction('memberMergeSnapshotDifferences'),
  extractFunction('memberMergeFinanceKey'),
  extractFunction('membershipPeriodsConflict'),
  extractFunction('assessMemberMergeState'),
  extractFunction('memberMergeChange'),
  extractFunction('assessMemberIdentityBindingState'),
  extractFunction('buildMemberIdentityBindingChanges'),
].join('\n'), context);

function item(path, data) {
  return {path, id: path.split('/').pop(), data};
}

const line = {
  uid: 'LINE_UID', realName: '跨年會員', displayName: 'LINE 暱稱',
  role: 'member', status: 'pending', approved: false, memberSource: 'line',
};
const manual = {
  uid: 'PERMANENT_UID', realName: '跨年會員', displayName: '跨年會員',
  role: 'member', status: 'approved', approved: true, memberSource: 'manual',
};
const candidateId = context.duplicateMemberPairId('LINE_UID', 'PERMANENT_UID');
const state = {
  candidate: item(`duplicateMemberCandidates/${candidateId}`, {
    status: 'pending', lineMemberUid: 'LINE_UID',
    manualMemberUid: 'PERMANENT_UID',
    lineMember: Object.assign({}, line),
    manualMember: Object.assign({}, manual),
  }),
  lineMember: item('members/LINE_UID', line),
  manualMember: item('members/PERMANENT_UID', manual),
  lineFinancialRecords: [item('financialRecords/F1', {
    memberId: 'LINE_UID', type: 'annual', status: 'active',
    membershipYear: 2028, amount: 3600,
  })],
  manualFinancialRecords: [],
  lineMembershipPeriods: [item('membershipPeriods/P1', {
    memberUid: 'LINE_UID', membershipYear: 2028,
    startDate: '2028-01-01', expiryDate: '2028-12-31', status: 'scheduled',
  })],
  manualMembershipPeriods: [],
  lineMembershipYearDecisions: [item(
    'membershipYearDecisions/2027_LINE_UID', {
      memberUid: 'LINE_UID', membershipYear: 2027,
      status: 'not_joining',
    })],
  manualMembershipYearDecisions: [],
  bookings: [item('bookings/B1', {
    createdBy: 'LINE_UID', players: ['LINE_UID'], status: 'confirmed',
  })],
  lineViolations: [item('bookingViolations/V1', {memberUid: 'LINE_UID'})],
  manualViolations: [],
  lineSummary: null,
  manualSummary: null,
  coachMembers: [item('members/COACH', {
    coachStudents: {LINE_UID: {claimedAt: '2028-01-01'}},
  })],
  lineNotifications: [item('notifications/N1', {uid: 'LINE_UID'})],
  notifications: [],
  extensionRequests: [],
  identityLink: null,
  identityClaim: null,
  memberIdentityLinks: [],
};

const assessment = context.assessMemberIdentityBindingState(state);
assert.strictEqual(assessment.canBind, true);
const changes = context.buildMemberIdentityBindingChanges(
  state, assessment, {uid: 'ADMIN_UID', name: '管理員'}, 'OP1',
  '2027-12-01T00:00:00.000Z',
);
const find = (path) => changes.find((change) => change.path === path);
assert.strictEqual(find('memberIdentityLinks/LINE_UID').after.memberUid,
  'PERMANENT_UID');
assert.strictEqual(find('memberIdentityClaims/PERMANENT_UID').after.lineUid,
  'LINE_UID');
assert.strictEqual(find('members/LINE_UID').after.status, 'merged');
assert.strictEqual(find('members/LINE_UID').after.mergedInto, 'PERMANENT_UID');
assert.strictEqual(find('members/PERMANENT_UID').after.status, 'approved');
assert.strictEqual(find('financialRecords/F1').after.memberId, 'PERMANENT_UID');
assert.strictEqual(find('membershipPeriods/P1').after.memberUid,
  'PERMANENT_UID');
assert.strictEqual(
  find('membershipYearDecisions/2027_LINE_UID').after.memberUid,
  'PERMANENT_UID',
);
assert.strictEqual(find('bookings/B1').after.createdBy, 'PERMANENT_UID');
assert.deepStrictEqual(Array.from(find('bookings/B1').after.players),
  ['PERMANENT_UID']);
assert.strictEqual(find('bookingViolations/V1').after.memberUid,
  'PERMANENT_UID');
assert.strictEqual(find('notifications/N1').after.uid, 'PERMANENT_UID');
assert(find('members/COACH').after.coachStudents.PERMANENT_UID);
assert(!find('members/COACH').after.coachStudents.LINE_UID);
assert.strictEqual(changes.filter((change) =>
  change.path.startsWith('membershipPeriods/')).length, 1);

const linkedElsewhere = Object.assign({}, state, {
  identityLink: item('memberIdentityLinks/LINE_UID', {
    lineUid: 'LINE_UID', memberUid: 'OTHER_UID', status: 'active',
  }),
});
assert.strictEqual(
  context.assessMemberIdentityBindingState(linkedElsewhere).canBind, false);

const claimedElsewhere = Object.assign({}, state, {
  identityClaim: item('memberIdentityClaims/PERMANENT_UID', {
    memberUid: 'PERMANENT_UID', lineUid: 'OTHER_LINE', status: 'active',
  }),
});
assert.strictEqual(
  context.assessMemberIdentityBindingState(claimedElsewhere).canBind, false);

const periodConflict = Object.assign({}, state, {
  manualMembershipPeriods: [item('membershipPeriods/OLD', {
    memberUid: 'PERMANENT_UID', membershipYear: 2028,
    startDate: '2028-01-01', expiryDate: '2028-12-31', status: 'active',
  })],
});
assert(context.assessMemberIdentityBindingState(periodConflict).blockers.some(
  (message) => message.includes('年度會員資格')));

const blockedLine = JSON.parse(JSON.stringify(state));
blockedLine.lineMember.data.status = 'blocked';
assert(context.assessMemberIdentityBindingState(blockedLine).blockers.some(
  (message) => message.includes('安全封鎖')));

[
  'function resolveMemberIdentity',
  'exports.previewMemberIdentityBinding = onCall',
  'exports.executeMemberIdentityBinding = onCall',
  'exports.rejectMemberIdentityBinding = onCall',
  'exports.rollbackMemberIdentityBinding = onCall',
  "collection('memberIdentityOperations')",
  "collection('memberIdentityAuditLogs')",
  'bookingDb.runTransaction',
  'assessment.previewHash !== previewHash',
].forEach((text) => assert(source.includes(text), `backend missing: ${text}`));

[
  "collection('memberIdentityLinks')",
  'memberUid});',
  'createCustomToken(\n        lineUserId, {role, status, memberUid})',
].forEach((text) => assert(lineauth.includes(text), `lineauth missing: ${text}`));

[
  'function openMemberIdentityBindingPreview',
  "httpsCallable('executeMemberIdentityBinding')",
  "httpsCallable('rejectMemberIdentityBinding')",
  '綁定不會自動建立年度資格',
].forEach((text) => assert(frontend.includes(text), `frontend missing: ${text}`));

[
  'function actorMemberId()',
  'match /memberIdentityLinks/{lineUid}',
  'match /memberIdentityClaims/{memberUid}',
  'match /memberIdentityOperations/{operationId}',
  'match /memberIdentityAuditLogs/{auditId}',
].forEach((text) => assert(rules.includes(text), `rules missing: ${text}`));

console.log('PASS LINE UID binds to the existing permanent member ID');
console.log('PASS finance, booking, violation, period and notification links move once');
console.log('PASS active link, reverse claim, period conflict and blocked identity are rejected');
console.log('PASS Transaction, preview hash, audit, rollback and Rules wiring');

(async () => {
  fakeDocs.set('members/AUTH_UID', {role: 'member'});
  let resolved = await context.resolveMemberIdentity('AUTH_UID');
  assert.strictEqual(resolved.memberUid, 'AUTH_UID');
  fakeDocs.set('memberIdentityLinks/LINE_UID', {
    lineUid: 'LINE_UID', memberUid: 'PERMANENT_UID', status: 'active',
  });
  fakeDocs.set('members/PERMANENT_UID', {role: 'member'});
  resolved = await context.resolveMemberIdentity('LINE_UID');
  assert.strictEqual(resolved.authUid, 'LINE_UID');
  assert.strictEqual(resolved.memberUid, 'PERMANENT_UID');
  fakeDocs.set('memberIdentityLinks/BROKEN', {
    lineUid: 'OTHER_UID', memberUid: 'PERMANENT_UID', status: 'active',
  });
  await assert.rejects(
    () => context.resolveMemberIdentity('BROKEN'),
    (error) => error.code === 'failed-precondition',
  );
  console.log('PASS resolver preserves legacy UID and resolves active LINE links');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
