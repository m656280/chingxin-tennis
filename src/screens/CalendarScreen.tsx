/**
 * CalendarScreen — Phase 3 prototype
 *
 * 對應 Architecture 文件第 3 章「首頁結構」：
 * - Header: KnotLogo + CHING XIN Tennis Society
 * - Calendar Layer (default Week View)
 * - 4 場地 × 30 分鐘 slot
 *
 * 目前使用 mock data，未接 Firestore。
 */

import { useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { KnotLogo } from '../components/KnotLogo';
import { ViewSwitcher, type ViewMode } from '../components/calendar/ViewSwitcher';
import { WeekStrip } from '../components/calendar/WeekStrip';
import { TimeGrid } from '../components/calendar/TimeGrid';
import {
  addDays,
  formatDate,
  formatDayLabel,
  getWeekDates,
  isWeekend,
  startOfWeek,
} from '../utils/date';
import { getBookingsForDate } from '../data/mockBookings';
import styles from './CalendarScreen.module.css';

export function CalendarScreen() {
  const { logout } = useAuth();

  // "今天" 在元件 mount 時定下，避免時鐘跨日造成 re-render race
  const today = useMemo(() => new Date(), []);
  const [selected, setSelected] = useState<Date>(today);
  const [viewMode, setViewMode] = useState<ViewMode>('week');

  const weekStart = useMemo(() => startOfWeek(selected), [selected]);
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const bookings = useMemo(
    () => getBookingsForDate(formatDate(selected)),
    [selected]
  );

  const handlePrevWeek = () => setSelected((d) => addDays(d, -7));
  const handleNextWeek = () => setSelected((d) => addDays(d, 7));

  const dayMeta = isWeekend(selected) ? '週末・寒暑假時段' : '平日時段';

  return (
    <div className={styles.container}>
      {/* Header */}
      <div style={{ position: 'relative' }}>
        <div className={styles.logoutSlot}>
          <button className={styles.logoutButton} onClick={logout}>
            登出
          </button>
        </div>
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.brandRow}>
              <KnotLogo size={22} />
              <span className={styles.brandName}>CHING XIN</span>
            </div>
            <span className={styles.brandSub}>Tennis Society</span>
          </div>
        </header>
      </div>

      {/* View switcher */}
      <ViewSwitcher mode={viewMode} onChange={setViewMode} />

      {/* Week strip */}
      <WeekStrip
        weekDates={weekDates}
        selected={selected}
        today={today}
        onSelect={setSelected}
        onPrevWeek={handlePrevWeek}
        onNextWeek={handleNextWeek}
      />

      {/* Day header */}
      <div className={styles.dayHeader}>
        <span className={styles.dayLabel}>{formatDayLabel(selected)}</span>
        <span className={styles.dayMeta}>· {dayMeta}</span>
      </div>

      {/* Time grid */}
      <TimeGrid date={selected} today={today} bookings={bookings} />

      <p className={styles.footer}>
        Phase 3 Preview · Mock Data
        <br />
        預約 / 收費功能將於後續階段開放
      </p>
    </div>
  );
}
