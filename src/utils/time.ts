/**
 * Time / slot helpers — pure functions.
 *
 * 對齊 Architecture 文件第 4 章：
 * - 平日 17:30 – 24:00
 * - 週末 / 寒暑假 05:30 – 24:00
 * - 1 slot = 30 分鐘
 */

export const SLOT_MINUTES = 30;
export const SLOT_HEIGHT_PX = 32;

export const WEEKDAY_OPEN = '17:30';
export const WEEKDAY_CLOSE = '24:00';
export const WEEKEND_OPEN = '05:30';
export const WEEKEND_CLOSE = '24:00';

/** HH:mm → 從 00:00 起算的分鐘數（24:00 → 1440） */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** 分鐘 → HH:mm */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 取得當日開放時段（依平日 / 週末） */
export function getDayOpenRange(weekend: boolean): { open: string; close: string } {
  return weekend
    ? { open: WEEKEND_OPEN, close: WEEKEND_CLOSE }
    : { open: WEEKDAY_OPEN, close: WEEKDAY_CLOSE };
}

/** 列出當日所有 30 分鐘 slot 起點時間（含 open，不含 close） */
export function getDaySlots(weekend: boolean): string[] {
  const { open, close } = getDayOpenRange(weekend);
  const result: string[] = [];
  let cur = timeToMinutes(open);
  const end = timeToMinutes(close);
  while (cur < end) {
    result.push(minutesToTime(cur));
    cur += SLOT_MINUTES;
  }
  return result;
}

/**
 * 計算 booking 在 grid 中的起點 slot 與跨度。
 * 用於 CSS grid-row 的 `start / span N` 寫法。
 */
export function getSlotPosition(
  startTime: string,
  endTime: string,
  dayOpen: string
): { startSlot: number; spanSlots: number } {
  const open = timeToMinutes(dayOpen);
  const startMin = timeToMinutes(startTime);
  const endMin = timeToMinutes(endTime);
  return {
    startSlot: Math.max(0, Math.floor((startMin - open) / SLOT_MINUTES)),
    spanSlots: Math.max(1, Math.floor((endMin - startMin) / SLOT_MINUTES)),
  };
}

/** 判斷 HH:mm 是否為整點 */
export function isFullHour(t: string): boolean {
  return t.endsWith(':00');
}

/** 取得目前時間在開放時段內的 slot 索引（小數），不在範圍內回傳 null */
export function getNowSlotIndex(
  weekend: boolean,
  now: Date = new Date()
): number | null {
  const { open, close } = getDayOpenRange(weekend);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const openMin = timeToMinutes(open);
  const closeMin = timeToMinutes(close);
  if (nowMin < openMin || nowMin >= closeMin) return null;
  return (nowMin - openMin) / SLOT_MINUTES;
}
