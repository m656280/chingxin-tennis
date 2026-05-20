/**
 * Date helpers — pure functions, 不依賴任何時區轉換 library。
 * 系統假設 Asia/Taipei，前端直接用 local time。
 */

export const DAYS_OF_WEEK_TC = ['日', '一', '二', '三', '四', '五', '六'] as const;
export const MONTHS_TC = [
  '1 月',
  '2 月',
  '3 月',
  '4 月',
  '5 月',
  '6 月',
  '7 月',
  '8 月',
  '9 月',
  '10 月',
  '11 月',
  '12 月',
] as const;

/** 格式 YYYY-MM-DD */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 取得指定日期所在週的星期日 00:00 */
export function startOfWeek(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

/** 取得一週七天（Sun → Sat） */
export function getWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function isSameDay(a: Date, b: Date): boolean {
  return formatDate(a) === formatDate(b);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** 5月18日 週一 */
export function formatDayLabel(d: Date): string {
  const month = MONTHS_TC[d.getMonth()];
  const day = d.getDate();
  const dayOfWeek = DAYS_OF_WEEK_TC[d.getDay()];
  return `${month}${day}日 週${dayOfWeek}`;
}

/** 2026 年 5 月 */
export function formatMonthYear(d: Date): string {
  return `${d.getFullYear()} 年 ${MONTHS_TC[d.getMonth()]}`;
}
