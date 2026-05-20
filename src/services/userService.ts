/**
 * User service — Firestore 讀寫邏輯。
 *
 * 所有對 `users` collection 的操作都集中在這裡。
 * UI / Context 不直接呼叫 firestore SDK。
 */

import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  DocumentData,
} from 'firebase/firestore';

import { db } from '../lib/firebase';
import { ROLES } from '../types/role';
import type { LineProfile, User } from '../types/user';

const USERS_COLLECTION = 'users';

/**
 * 確保 user document 存在。
 *
 * - 首次登入：建立 document，role 預設 pending、clayAccess=false
 * - 二次以後：更新 lastLoginAt 與 lineAvatar（用戶可能換 LINE 頭像）
 *
 * 不會覆寫 role、ntrp、clayAccess 等欄位。
 */
export async function ensureUserDocument(profile: LineProfile): Promise<void> {
  const ref = doc(db, USERS_COLLECTION, profile.userId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      userId: profile.userId,
      displayName: profile.displayName,
      lineAvatar: profile.lineAvatar,
      role: ROLES.PENDING,
      clayAccess: false,
      membershipStatus: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
    return;
  }

  // Existing user — 只更新 avatar 與 lastLoginAt
  await setDoc(
    ref,
    {
      lineAvatar: profile.lineAvatar,
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * 訂閱單一 user document。
 * 回傳 unsubscribe function。
 */
export function subscribeToUser(
  userId: string,
  callback: (user: User | null) => void
): () => void {
  const ref = doc(db, USERS_COLLECTION, userId);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        callback(null);
        return;
      }
      callback(mapDocToUser(snap.data()));
    },
    (err) => {
      console.error('[userService] subscribeToUser error:', err);
      callback(null);
    }
  );
}

/* --- helpers --- */

function tsToDate(value: unknown): Date | undefined {
  if (value instanceof Timestamp) return value.toDate();
  return undefined;
}

function mapDocToUser(data: DocumentData): User {
  return {
    userId: data.userId,
    displayName: data.displayName,
    lineAvatar: data.lineAvatar ?? '',
    role: data.role,
    ntrp: data.ntrp,
    preferredPosition: data.preferredPosition,
    coachId: data.coachId,
    clayAccess: data.clayAccess ?? false,
    annualExpiresAt: tsToDate(data.annualExpiresAt) ?? null,
    monthlyExpiresAt: tsToDate(data.monthlyExpiresAt) ?? null,
    membershipStatus: data.membershipStatus ?? 'pending',
    createdAt: tsToDate(data.createdAt) ?? new Date(),
    updatedAt: tsToDate(data.updatedAt) ?? new Date(),
    lastLoginAt: tsToDate(data.lastLoginAt),
  };
}
