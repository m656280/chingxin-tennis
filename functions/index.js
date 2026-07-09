/**
 * Firebase Cloud Functions — Deta / 清心網球協會
 * functions/ codebase (default)
 *
 * Auth approach: Firebase Authentication + OIDC provider (oidc.line)
 * Frontend calls signInWithPopup(new OAuthProvider('oidc.line')) directly.
 * No custom token, no LIFF token verification needed here.
 *
 * This file is reserved for future server-side functions:
 *   - Admin: approve / block / resign members
 *   - Scheduled: expire monthly memberships
 *   - Triggers: on new member created → notify admin
 */

'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

admin.initializeApp();

// ── createManualMember ────────────────────────────────────────────────
// 管理員手動建立會員（無 LINE 帳號者）。
// 由 Admin SDK 寫入 Firestore（bypass rules），
// 呼叫者身份驗證：request.auth.uid → members/{uid}.role 必須為 owner/admin。
// docId = Firestore auto-ID，uid 欄位 = docId（與 LINE 會員結構一致）。
exports.createManualMember = onCall({ region: 'asia-east1' }, async (request) => {
  // ① 必須已完成 Firebase Auth 登入
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Firebase Auth 尚未登入，請重新用 LINE 登入後再試');
  }

  // ② 呼叫者 role 以 Firestore member doc 為準（不信任 client、不依賴可能過期的 token claims）
  const db = admin.firestore();
  const callerSnap = await db.collection('members').doc(request.auth.uid).get();
  const callerRole = callerSnap.exists ? (callerSnap.data().role || '') : '';
  if (callerRole !== 'owner' && callerRole !== 'admin') {
    throw new HttpsError('permission-denied',
      '僅 owner/admin 可手動建立會員（目前身份 role: ' + (callerRole || 'unknown') + '）');
  }

  // ③ 輸入驗證（role 僅允許 member/coach，其餘欄位白名單）
  const d = request.data || {};
  const realName = (typeof d.realName === 'string') ? d.realName.trim() : '';
  if (!realName || realName.length > 50) {
    throw new HttpsError('invalid-argument', 'realName 必填，50 字以內');
  }
  const displayName = (typeof d.displayName === 'string' && d.displayName.trim())
    ? d.displayName.trim().slice(0, 50) : realName;
  const role = (d.role === 'coach') ? 'coach' : 'member';
  const membershipType = ['annual', 'monthly'].includes(d.membershipType) ? d.membershipType : '';
  const ntrp = (typeof d.ntrp === 'string') ? d.ntrp.slice(0, 10) : '';
  const preferredPosition = (typeof d.preferredPosition === 'string') ? d.preferredPosition.slice(0, 10) : '';

  // ④ 單次寫入（uid = docId，避免 add 後再 update）
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection('members').doc();
  await ref.set({
    uid:               ref.id,
    realName:          realName,
    displayName:       displayName,
    photoURL:          '',
    role:              role,
    membershipType:    membershipType,
    status:            'approved',
    memberSource:      'manual',
    approved:          true,
    ntrp:              ntrp,
    preferredPosition: preferredPosition,
    createdAt:         now,
    updatedAt:         now,
    approvedAt:        now,
    approvedBy:        request.auth.uid,
    lastLoginAt:       null,
  });

  console.info('[createManualMember]', realName, '| role:', role, '| by:', request.auth.uid, '→', ref.id);
  return { ok: true, uid: ref.id };
});

// ── Placeholder: future admin / trigger functions go here ─────────────
// Example (not deployed yet):
//
// exports.onNewMember = functions
//   .region('asia-east1')
//   .firestore.document('members/{uid}')
//   .onCreate(async (snap, context) => {
//     const member = snap.data();
//     console.info('[onNewMember] New pending member:', member.displayName);
//     // TODO: notify admin via LINE Notify or FCM
//   });
