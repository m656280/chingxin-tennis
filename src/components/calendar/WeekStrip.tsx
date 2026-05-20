import {
  DAYS_OF_WEEK_TC,
  formatMonthYear,
  isSameDay,
  isWeekend,
} from '../../utils/date';
import styles from './WeekStrip.module.css';

interface WeekStripProps {
  weekDates: Date[];
  selected: Date;
  today: Date;
  onSelect: (d: Date) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

export function WeekStrip({
  weekDates,
  selected,
  today,
  onSelect,
  onPrevWeek,
  onNextWeek,
}: WeekStripProps) {
  // Month label 用本週「中間那天」（週三）所在月份，避免跨月時誤判
  const monthAnchor = weekDates[3] ?? weekDates[0];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button
          className={styles.navButton}
          onClick={onPrevWeek}
          aria-label="上一週"
        >
          ‹
        </button>
        <span className={styles.monthLabel}>{formatMonthYear(monthAnchor)}</span>
        <button
          className={styles.navButton}
          onClick={onNextWeek}
          aria-label="下一週"
        >
          ›
        </button>
      </div>

      <div className={styles.chips}>
        {weekDates.map((d) => {
          const isSel = isSameDay(d, selected);
          const isTod = isSameDay(d, today);
          const cls = [
            styles.chip,
            isSel && styles.selected,
            isTod && styles.today,
            isWeekend(d) && styles.weekend,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={d.toISOString()}
              className={cls}
              onClick={() => onSelect(d)}
              aria-pressed={isSel}
              aria-label={`${d.getMonth() + 1}月${d.getDate()}日`}
            >
              <span className={styles.dayLabel}>
                {DAYS_OF_WEEK_TC[d.getDay()]}
              </span>
              <span className={styles.dateNum}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
