'use strict';

const assert = require('assert');
const admin = require('firebase-admin');
const functions = require('./index.js');

const db = admin.firestore();

async function seed() {
  const batch = db.batch();
  const members = {
    adminA: {uid: 'adminA', role: 'admin', status: 'approved', approved: true},
    ownerA: {uid: 'ownerA', role: 'owner', status: 'approved', approved: true},
    memberA: {uid: 'memberA', realName: '年度會員甲', role: 'member', status: 'approved', approved: true},
    blockedA: {uid: 'blockedA', role: 'member', status: 'blocked', approved: false},
    deletedA: {uid: 'deletedA', role: 'member', status: 'deleted', approved: false},
    adminTarget: {uid: 'adminTarget', role: 'admin', status: 'approved', approved: true},
    noPeriodA: {uid: 'noPeriodA', role: 'member', status: 'approved', approved: true},
    journeyA: {uid: 'journeyA', role: 'member', status: 'approved', approved: true},
    revokeA: {uid: 'revokeA', role: 'member', status: 'approved', approved: true},
  };
  Object.entries(members).forEach(([id, data]) => {
    batch.set(db.collection('members').doc(id), data);
  });
  const periods = {
    member2026: {
      memberUid: 'memberA', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
    member2027: {
      memberUid: 'memberA', membershipYear: 2027,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2027-01-01',
      expiryDate: '2027-12-31', status: 'scheduled',
    },
    blocked2026: {
      memberUid: 'blockedA', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
    adminTarget2026: {
      memberUid: 'adminTarget', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
    noPeriod2026: {
      memberUid: 'noPeriodA', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
    journey2026: {
      memberUid: 'journeyA', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
    revoke2026: {
      memberUid: 'revokeA', membershipYear: 2026,
      membershipType: 'annual', membershipPlan: 'annual_standard',
      membershipPlanLabel: '一般年費', startDate: '2026-01-01',
      expiryDate: '2026-12-31', status: 'active',
    },
  };
  Object.entries(periods).forEach(([id, data]) => {
    batch.set(db.collection('membershipPeriods').doc(id), data);
  });
  batch.set(db.collection('financialRecords').doc('noPeriodFinance2027'), {
    memberId: 'noPeriodA', type: 'annual', membershipYear: 2027,
    accountingDate: '2027-01-01', date: '2026-12-01', amount: 1000,
    status: 'active',
  });
  await batch.commit();
}

function call(name, uid, data) {
  return functions[name].run({auth: {uid}, data});
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

async function main() {
  await seed();

  const resignInput = {
    memberUid: 'memberA', membershipYear: 2026, reason: '本人主動離會',
    requestId: 'resign-2026-1',
  };
  const resigned = await call('resignMembershipYear', 'adminA', resignInput);
  assert.strictEqual(resigned.affectedCount, 1);
  assert.strictEqual((await db.doc('membershipPeriods/member2026').get()).data().status, 'resigned');
  assert.strictEqual((await db.doc('membershipPeriods/member2027').get()).data().status, 'scheduled');
  assert.strictEqual((await db.doc('members/memberA').get()).data().status, 'approved');
  assert.strictEqual((await call('resignMembershipYear', 'adminA', resignInput)).idempotent, true);

  await expectCode(call('restoreMembershipYear', 'adminA', {
    memberUid: 'memberA', membershipYear: 2026, reason: '恢復資格',
    requestId: 'restore-2026-no-confirm',
  }), 'failed-precondition');
  const restored = await call('restoreMembershipYear', 'adminA', {
    memberUid: 'memberA', membershipYear: 2026, reason: '管理員確認恢復',
    requestId: 'restore-2026-1', confirmRestore: true,
  });
  assert.strictEqual(restored.affectedCount, 1);
  assert.strictEqual((await db.doc('membershipPeriods/member2026').get()).data().status, 'active');
  assert.strictEqual((await db.doc('members/memberA').get()).data().status, 'approved');

  await call('resignMembershipYear', 'adminA', {
    memberUid: 'blockedA', membershipYear: 2026, reason: '封鎖期間離會',
    requestId: 'blocked-resign-1',
  });
  assert.strictEqual((await db.doc('members/blockedA').get()).data().status, 'blocked');
  await call('restoreMembershipYear', 'adminA', {
    memberUid: 'blockedA', membershipYear: 2026, reason: '只恢復年度資格',
    requestId: 'blocked-restore-1', confirmRestore: true,
  });
  assert.strictEqual((await db.doc('members/blockedA').get()).data().status, 'blocked');

  const classificationInput = {
    membershipPeriodId: 'member2026', membershipPlan: 'annual_senior',
    reason: '補登銀爸銀媽分類', requestId: 'classification-1',
  };
  assert.strictEqual((await call(
    'updateMembershipPeriodClassification', 'adminA', classificationInput,
  )).idempotent, false);
  assert.strictEqual(
    (await db.doc('membershipPeriods/member2026').get()).data().membershipPlan,
    'annual_senior',
  );
  assert.strictEqual(
    (await db.doc('membershipPeriods/member2027').get()).data().membershipPlan,
    'annual_standard',
  );
  assert.strictEqual((await call(
    'updateMembershipPeriodClassification', 'adminA', classificationInput,
  )).idempotent, true);
  const classificationAudit = await db.collection('membershipPeriodAuditLogs')
    .where('action', '==', 'membership_classification_changed').get();
  assert.strictEqual(classificationAudit.size, 1);
  assert.strictEqual(classificationAudit.docs[0].data().before.membershipPlan, 'annual_standard');
  assert.strictEqual(classificationAudit.docs[0].data().after.membershipPlan, 'annual_senior');

  await expectCode(call('updateMembershipPeriodClassification', 'adminA', {
    membershipPeriodId: 'member2026', membershipPlan: 'monthly',
    reason: '錯誤類型', requestId: 'classification-invalid',
  }), 'failed-precondition');
  await expectCode(call('resignMembershipYear', 'adminA', {
    memberUid: 'noPeriodA', membershipYear: 2027, reason: '未續會',
    requestId: 'no-period-resign',
  }), 'failed-precondition');
  assert.strictEqual((await db.doc('members/noPeriodA').get()).data().status, 'approved');

  await expectCode(call('resignMembershipYear', 'adminA', {
    memberUid: 'adminTarget', membershipYear: 2026, reason: '權限測試',
    requestId: 'admin-target-denied',
  }), 'permission-denied');
  await call('resignMembershipYear', 'ownerA', {
    memberUid: 'adminTarget', membershipYear: 2026, reason: 'Owner 操作',
    requestId: 'owner-admin-target',
  });

  const notJoiningInput = {
    memberUid: 'journeyA', membershipYear: 2027, note: '本年度暫不參加',
    requestId: 'journey-not-joining-2027',
  };
  const notJoining = await call(
    'markMembershipYearNotJoining', 'adminA', notJoiningInput,
  );
  assert.strictEqual(notJoining.idempotent, false);
  assert.strictEqual(
    (await db.doc('membershipYearDecisions/2027_journeyA').get()).data().status,
    'not_joining',
  );
  assert.strictEqual((await db.doc('members/journeyA').get()).data().status, 'approved');
  assert.strictEqual(
    (await db.doc('membershipPeriods/journey2026').get()).data().status,
    'active',
  );
  assert.strictEqual((await call(
    'markMembershipYearNotJoining', 'adminA', notJoiningInput,
  )).idempotent, true);
  await expectCode(call('markMembershipYearNotJoining', 'memberA', {
    memberUid: 'journeyA', membershipYear: 2027,
    requestId: 'member-cannot-decide',
  }), 'permission-denied');
  await expectCode(call('markMembershipYearNotJoining', 'adminA', {
    memberUid: 'memberA', membershipYear: 2027,
    requestId: 'period-conflict-decision',
  }), 'failed-precondition');
  await expectCode(call('markMembershipYearNotJoining', 'adminA', {
    memberUid: 'noPeriodA', membershipYear: 2027,
    requestId: 'finance-conflict-decision',
  }), 'failed-precondition');
  await expectCode(call('createMembershipRenewal', 'adminA', {
    memberUid: 'journeyA', membershipPlan: 'annual_standard',
    membershipYear: 2027, paymentDate: '2026-12-01',
    accountingYear: 2027, amount: 1000,
    idempotencyKey: 'decision-blocks-renewal',
  }), 'failed-precondition');
  await call('createMembershipRenewal', 'adminA', {
    memberUid: 'journeyA', membershipPlan: 'monthly',
    membershipYear: 2028, paymentDate: '2027-12-20',
    accountingDate: '2028-01-01', accountingYear: 2028,
    periodMonths: 1, amount: 800,
    idempotencyKey: 'journey-2028-monthly',
  });
  const journeyPeriods = await db.collection('membershipPeriods')
    .where('memberUid', '==', 'journeyA').get();
  assert.deepStrictEqual(
    journeyPeriods.docs.map((doc) => doc.data().membershipYear).sort(),
    [2026, 2028],
  );
  assert.strictEqual(
    journeyPeriods.docs.find((doc) => doc.data().membershipYear === 2028)
      .data().membershipPlan,
    'monthly',
  );
  assert.strictEqual(
    (await db.doc('membershipYearDecisions/2027_journeyA').get()).data().status,
    'not_joining',
  );

  await call('markMembershipYearNotJoining', 'adminA', {
    memberUid: 'revokeA', membershipYear: 2027, note: '暫不加入',
    requestId: 'revoke-member-mark-2027',
  });
  await call('revokeMembershipYearNotJoining', 'adminA', {
    memberUid: 'revokeA', membershipYear: 2027,
    reason: '恢復待續會', requestId: 'revoke-2027-1',
  });
  assert.strictEqual(
    (await db.doc('membershipYearDecisions/2027_revokeA').get()).data().status,
    'revoked',
  );

  await call('createMembershipRenewal', 'adminA', {
    memberUid: 'deletedA', membershipPlan: 'annual_standard',
    membershipYear: 2028, paymentDate: '2026-11-10',
    accountingYear: 2028, amount: 1000,
    idempotencyKey: 'deleted-renewal-no-restore',
  });
  assert.strictEqual((await db.doc('members/deletedA').get()).data().status, 'deleted');

  const ownerRosterExport = await call('getAnnualMemberRosterExport', 'ownerA', {
    membershipYear: 2026,
  });
  assert(ownerRosterExport.rows.some((row) => row.memberName === '年度會員甲'));
  assert(ownerRosterExport.rows.every((row) =>
    !Object.prototype.hasOwnProperty.call(row, 'memberUid') &&
    !Object.prototype.hasOwnProperty.call(row, 'email') &&
    !Object.prototype.hasOwnProperty.call(row, 'phone') &&
    !Object.prototype.hasOwnProperty.call(row, 'lineUserId')));
  const adminRosterExport = await call('getAnnualMemberRosterExport', 'adminA', {
    membershipYear: 2027,
  });
  assert(Array.isArray(adminRosterExport.rows));
  await expectCode(call('getAnnualMemberRosterExport', 'memberA', {
    membershipYear: 2026,
  }), 'permission-denied');
  await expectCode(functions.getAnnualMemberRosterExport.run({
    auth: null, data: {membershipYear: 2026},
  }), 'unauthenticated');

  const audits = await db.collection('membershipPeriodAuditLogs').get();
  assert(audits.size >= 5);
  console.log('membership period lifecycle tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
