/**
 * Role definitions for Deta.
 *
 * 與 Deta_Data_Model.md 第 5 節對齊。
 * 修改此處前，請先更新 Data Model 文件。
 */

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  ANNUAL_MEMBER: 'annual_member',
  MONTHLY_MEMBER: 'monthly_member',
  COACH: 'coach',
  PENDING: 'pending',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** 中文顯示名稱（給 UI 用） */
export const ROLE_LABELS: Record<Role, string> = {
  owner: '擁有者',
  admin: '管理員',
  annual_member: '年費會員',
  monthly_member: '月費會員',
  coach: '教練',
  pending: '待審核',
};

/** Role badge 對應的 CSS variable 名稱 */
export const ROLE_DOT_VAR: Record<Role, string> = {
  owner: 'var(--dot-owner)',
  admin: 'var(--dot-admin)',
  annual_member: 'var(--dot-annual)',
  monthly_member: 'var(--dot-monthly)',
  coach: 'var(--dot-coach)',
  pending: 'var(--dot-pending)',
};

/** 判斷 role 是否屬於管理層（owner / admin） */
export function isManagement(role: Role): boolean {
  return role === ROLES.OWNER || role === ROLES.ADMIN;
}

/** 判斷 role 是否仍在待審核狀態 */
export function isPending(role: Role): boolean {
  return role === ROLES.PENDING;
}
