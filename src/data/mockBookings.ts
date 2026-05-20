/**
 * Mock bookings for Phase 3 prototype.
 *
 * 以「今天」為錨點動態生成，所以開啟 prototype 永遠看到當週的事件。
 * 等接 Firestore 後整個檔案會被刪除。
 */

import type { MockBooking } from '../types/booking';
import { addDays, formatDate, isWeekend } from '../utils/date';

function relDate(offset: number): string {
  return formatDate(addDays(new Date(), offset));
}

/** 從今天起，找下一個指定 day-of-week 的 offset（0=Sun, 6=Sat） */
function offsetToNext(targetDow: number): number {
  const todayDow = new Date().getDay();
  const diff = (targetDow - todayDow + 7) % 7;
  return diff === 0 ? 7 : diff;
}

const TODAY = relDate(0);
const TOMORROW = relDate(1);
const D2 = relDate(2);
const NEXT_SAT = relDate(offsetToNext(6));
const NEXT_SUN = relDate(offsetToNext(0));

/** 今天到底是不是週末，決定要不要塞早場 */
const todayIsWeekend = isWeekend(new Date());

export const MOCK_BOOKINGS: MockBooking[] = [
  /* --- 今天（若為平日，從 17:30 開始；若為週末，加幾筆早場） --- */
  ...(todayIsWeekend
    ? [
        {
          id: 'mb-w01',
          date: TODAY,
          startTime: '07:00',
          endTime: '09:00',
          court: 'clay_a' as const,
          mode: 'normal' as const,
          primaryName: '早晨組',
          participantCount: 4,
        },
        {
          id: 'mb-w02',
          date: TODAY,
          startTime: '09:30',
          endTime: '11:30',
          court: 'hard_a' as const,
          mode: 'coaching' as const,
          primaryName: 'Coach 王',
          participantCount: 3,
        },
      ]
    : []),
  {
    id: 'mb-001',
    date: TODAY,
    startTime: '18:00',
    endTime: '19:30',
    court: 'hard_a',
    mode: 'normal',
    primaryName: '林志強',
    participantCount: 4,
  },
  {
    id: 'mb-002',
    date: TODAY,
    startTime: '19:00',
    endTime: '20:30',
    court: 'hard_b',
    mode: 'coaching',
    primaryName: 'Coach Lin',
    participantCount: 2,
  },
  {
    id: 'mb-003',
    date: TODAY,
    startTime: '20:00',
    endTime: '22:00',
    court: 'clay_a',
    mode: 'normal',
    primaryName: '王雅琴',
    participantCount: 4,
  },
  {
    id: 'mb-004',
    date: TODAY,
    startTime: '21:00',
    endTime: '23:00',
    court: 'clay_b',
    mode: 'group_class',
    primaryName: 'Coach 吳 團課',
    participantCount: 6,
  },

  /* --- 明天 --- */
  {
    id: 'mb-005',
    date: TOMORROW,
    startTime: '18:30',
    endTime: '20:30',
    court: 'hard_a',
    mode: 'pickleball',
    primaryName: '匹克球聚會',
    participantCount: 8,
  },
  {
    id: 'mb-006',
    date: TOMORROW,
    startTime: '19:30',
    endTime: '21:00',
    court: 'clay_a',
    mode: 'coaching',
    primaryName: 'Coach Chen',
    participantCount: 2,
  },

  /* --- 後天（活動鎖場，雙場） --- */
  {
    id: 'mb-007',
    date: D2,
    startTime: '18:00',
    endTime: '21:00',
    court: 'hard_a',
    mode: 'event_lock',
    primaryName: '會員之夜',
    participantCount: 0,
  },
  {
    id: 'mb-008',
    date: D2,
    startTime: '18:00',
    endTime: '21:00',
    court: 'hard_b',
    mode: 'event_lock',
    primaryName: '會員之夜',
    participantCount: 0,
  },

  /* --- 本週六 / 日（週末早場展示） --- */
  {
    id: 'mb-009',
    date: NEXT_SAT,
    startTime: '07:00',
    endTime: '09:00',
    court: 'clay_a',
    mode: 'normal',
    primaryName: '張教練 私訓',
    participantCount: 2,
  },
  {
    id: 'mb-010',
    date: NEXT_SAT,
    startTime: '08:30',
    endTime: '10:30',
    court: 'hard_a',
    mode: 'coaching',
    primaryName: 'Coach 黃',
    participantCount: 3,
  },
  {
    id: 'mb-011',
    date: NEXT_SAT,
    startTime: '19:00',
    endTime: '21:00',
    court: 'hard_b',
    mode: 'normal',
    primaryName: '陳俊宏',
    participantCount: 4,
  },
  {
    id: 'mb-012',
    date: NEXT_SUN,
    startTime: '08:00',
    endTime: '10:00',
    court: 'hard_a',
    mode: 'normal',
    primaryName: '週日早場',
    participantCount: 4,
  },
];

export function getBookingsForDate(date: string): MockBooking[] {
  return MOCK_BOOKINGS.filter((b) => b.date === date);
}
