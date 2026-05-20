import { CSSProperties } from 'react';
import {
  COURT_SURFACE,
  MODE_LABELS,
  modeDotColor,
  type MockBooking,
} from '../../types/booking';
import styles from './EventBlock.module.css';

interface EventBlockProps {
  booking: MockBooking;
  spanSlots: number;
  style?: CSSProperties;
}

export function EventBlock({ booking, spanSlots, style }: EventBlockProps) {
  const surface = COURT_SURFACE[booking.court];
  const isEventLock = booking.mode === 'event_lock';
  const dotColor = modeDotColor(booking.mode);

  const cls = [
    styles.block,
    isEventLock ? styles.eventLock : surface === 'clay' ? styles.clay : '',
    spanSlots <= 1 ? styles.short : '',
  ]
    .filter(Boolean)
    .join(' ');

  const showMeta = spanSlots >= 3; // 1.5 小時以上才有空間顯示 meta

  return (
    <div className={cls} style={style}>
      {dotColor && (
        <span
          className={styles.modeDot}
          style={{ background: dotColor }}
          aria-hidden
        />
      )}
      <span className={styles.time}>{booking.startTime}</span>
      <span className={styles.name}>{booking.primaryName}</span>
      {showMeta && (
        <span className={styles.meta}>
          {MODE_LABELS[booking.mode]}
          {booking.participantCount > 0 && ` · ${booking.participantCount}P`}
        </span>
      )}
    </div>
  );
}
