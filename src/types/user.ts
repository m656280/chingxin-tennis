import { Role } from './role';

/**
 * User document shape (用戶資料模型).
 *
 * 對應 Firestore collection: `users`
 * 對應 Data Model 文件第 2.1 節。
 *
 * Phase 1 僅使用最小欄位集；其餘欄位由後續 Phase 補上。
 */
export interface User {
  userId: string;
  lineAvatar: string;
  displayName: string;
  role: Role;

  /* --- 會員自訂欄位（Phase 4 以後才在 UI 暴露） --- */
  ntrp?: number;
  preferredPosition?: string;
  coachId?: string;

  /* --- 由管理層維護 --- */
  clayAccess: boolean;

  /* --- 會籍狀態 --- */
  annualExpiresAt?: Date | null;
  monthlyExpiresAt?: Date | null;
  membershipStatus: 'active' | 'expired' | 'pending';

  /* --- 系統時間戳 --- */
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

/** LIFF 拿到的 LINE Profile，用於建立 / 更新 user document */
export interface LineProfile {
  userId: string;
  displayName: string;
  lineAvatar: string;
}
