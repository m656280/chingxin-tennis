/**
 * Booking & Court types.
 *
 * 對應 Deta_Data_Model.md 第 2.2 節 + 附錄 A。
 * Phase 3 prototype 僅使用其中的可視欄位。
 */

/* --- Courts --- */

export const COURTS = {
  HARD_A: 'hard_a',
  HARD_B: 'hard_b',
  CLAY_A: 'clay_a',
  CLAY_B: 'clay_b',
} as const;

export type Court = (typeof COURTS)[keyof typeof COURTS];

export type Surface = 'hard' | 'clay';

export const COURT_ORDER: Court[] = [
  COURTS.HARD_A,
  COURTS.HARD_B,
  COURTS.CLAY_A,
  COURTS.CLAY_B,
];

export const COURT_SURFACE: Record<Court, Surface> = {
  hard_a: 'hard',
  hard_b: 'hard',
  clay_a: 'clay',
  clay_b: 'clay',
};

export const COURT_LABELS: Record<Court, { surface: string; letter: string }> = {
  hard_a: { surface: 'HARD', letter: 'A' },
  hard_b: { surface: 'HARD', letter: 'B' },
  clay_a: { surface: 'CLAY', letter: 'A' },
  clay_b: { surface: 'CLAY', letter: 'B' },
};

/* --- Booking modes --- */

export const MODES = {
  NORMAL: 'normal',
  COACHING: 'coaching',
  GROUP_CLASS: 'group_class',
  PICKLEBALL: 'pickleball',
  EVENT_LOCK: 'event_lock',
} as const;

export type BookingMode = (typeof MODES)[keyof typeof MODES];

export const MODE_LABELS: Record<BookingMode, string> = {
  normal: '一般',
  coaching: '教學',
  group_class: '團課',
  pickleball: '匹克球',
  event_lock: '活動',
};

/**
 * 該 mode 是否要顯示右上角的 mode dot
 * - normal / pickleball：不顯示（背景色已表達 surface）
 * - coaching / group_class：黃點
 * - event_lock：綠點
 */
export function modeDotColor(mode: BookingMode): string | null {
  switch (mode) {
    case 'coaching':
    case 'group_class':
      return 'var(--dot-coach)';
    case 'event_lock':
      return 'var(--dot-event)';
    default:
      return null;
  }
}

/* --- Mock booking shape ---
 * 比 Firestore 模型輕量；Phase 3 prototype 用。
 */
export interface MockBooking {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  court: Court;
  mode: BookingMode;
  /** 顯示名稱（代掛時為實際使用者，event_lock 為事件名） */
  primaryName: string;
  /** 參與人數，event_lock 為 0 */
  participantCount: number;
}
