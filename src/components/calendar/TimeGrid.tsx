import {
  COURT_LABELS,
  COURT_ORDER,
  COURT_SURFACE,
  type MockBooking,
} from '../../types/booking';
import { isSameDay, isWeekend } from '../../utils/date';
import {
  getDayOpenRange,
  getDaySlots,
  getNowSlotIndex,
  getSlotPosition,
  isFullHour,
  SLOT_HEIGHT_PX,
} from '../../utils/time';
import { EventBlock } from './EventBlock';
import styles from './TimeGrid.module.css';

interface TimeGridProps {
  date: Date;
  today: Date;
  bookings: MockBooking[];
}

export function TimeGrid({ date, today, bookings }: TimeGridProps) {
  const weekend = isWeekend(date);
  const { open } = getDayOpenRange(weekend);
  const slots = getDaySlots(weekend);
  const showNow = isSameDay(date, today);
  const nowSlot = showNow ? getNowSlotIndex(weekend) : null;

  return (
    <div className={styles.wrapper}>
      {/* Court header row */}
      <div className={styles.courtHeader}>
        <div className={styles.timeAxisHead} />
        {COURT_ORDER.map((c) => (
          <div
            key={c}
            className={`${styles.courtLabel} ${
              COURT_SURFACE[c] === 'clay' ? styles.clay : ''
            }`}
          >
            <span className={styles.surfaceTag}>{COURT_LABELS[c].surface}</span>
            <span className={styles.courtLetter}>{COURT_LABELS[c].letter}</span>
          </div>
        ))}
      </div>

      {/* Body grid */}
      <div
        className={styles.grid}
        style={{
          gridTemplateRows: `repeat(${slots.length}, ${SLOT_HEIGHT_PX}px)`,
        }}
      >
        {/* Vertical court dividers (background layer) */}
        <div
          className={styles.courtDividers}
          style={{
            gridTemplateRows: `repeat(${slots.length}, ${SLOT_HEIGHT_PX}px)`,
          }}
        >
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>

        {/* Slot rows (gridlines + time labels) */}
        {slots.map((slot, i) => {
          const full = isFullHour(slot);
          const showLabel = full || i === 0;
          const cls = [
            styles.slotRow,
            full && styles.fullHour,
            i === 0 && styles.firstRow,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={slot}
              className={cls}
              style={{ gridRow: i + 1, gridColumn: '1 / -1' }}
            >
              <span className={styles.timeLabel}>
                {showLabel ? slot : ''}
              </span>
            </div>
          );
        })}

        {/* Event blocks */}
        {bookings.map((b) => {
          const { startSlot, spanSlots } = getSlotPosition(
            b.startTime,
            b.endTime,
            open
          );
          const courtIndex = COURT_ORDER.indexOf(b.court);
          if (courtIndex < 0) return null;
          return (
            <EventBlock
              key={b.id}
              booking={b}
              spanSlots={spanSlots}
              style={{
                gridColumn: courtIndex + 2,
                gridRow: `${startSlot + 1} / span ${spanSlots}`,
              }}
            />
          );
        })}

        {/* Now indicator */}
        {nowSlot !== null && (
          <div
            className={styles.nowLine}
            style={{ top: `${nowSlot * SLOT_HEIGHT_PX}px` }}
            aria-label="目前時間"
          />
        )}
      </div>
    </div>
  );
}
