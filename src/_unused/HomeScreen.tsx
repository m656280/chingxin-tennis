import { useAuth } from '../contexts/AuthContext';
import { ROLE_LABELS, ROLE_DOT_VAR } from '../types/role';
import { KnotLogo } from '../components/KnotLogo';
import styles from './HomeScreen.module.css';

export function HomeScreen() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <KnotLogo size={20} />
          <span className={styles.brandText}>CHING XIN</span>
        </div>
        <button className={styles.logoutButton} onClick={logout}>
          登出
        </button>
      </header>

      <div className={styles.profileCard}>
        {user.lineAvatar && (
          <img
            src={user.lineAvatar}
            alt={user.displayName}
            className={styles.avatar}
          />
        )}
        <h1 className={styles.name}>{user.displayName}</h1>
        <div className={styles.roleBadge}>
          <span
            className={styles.roleDot}
            style={{ background: ROLE_DOT_VAR[user.role] }}
          />
          <span>{ROLE_LABELS[user.role]}</span>
        </div>
      </div>

      <p className={styles.placeholder}>
        日曆、預約、收費功能將於後續階段開放
      </p>
    </div>
  );
}
