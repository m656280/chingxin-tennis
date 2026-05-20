import styles from './ViewSwitcher.module.css';

export type ViewMode = 'day' | 'week' | 'month';

interface ViewSwitcherProps {
  mode: ViewMode;
  /** Phase 3 只有 week 啟用；day / month 暫時 disabled */
  onChange?: (mode: ViewMode) => void;
}

const OPTIONS: { value: ViewMode; label: string; enabled: boolean }[] = [
  { value: 'day', label: 'Day', enabled: false },
  { value: 'week', label: 'Week', enabled: true },
  { value: 'month', label: 'Month', enabled: false },
];

export function ViewSwitcher({ mode, onChange }: ViewSwitcherProps) {
  return (
    <div className={styles.container}>
      <div className={styles.group} role="tablist" aria-label="View mode">
        {OPTIONS.map((opt) => {
          const active = mode === opt.value;
          const cls = [
            styles.option,
            active && styles.active,
            !opt.enabled && styles.disabled,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={opt.value}
              className={cls}
              disabled={!opt.enabled}
              onClick={() => opt.enabled && onChange?.(opt.value)}
              role="tab"
              aria-selected={active}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
