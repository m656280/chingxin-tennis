import { useAuth } from '../contexts/AuthContext';
import styles from './PendingScreen.module.css';

export function PendingScreen() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className={styles.container}>
      {user.lineAvatar && (
        <img
          src={user.lineAvatar}
          alt={user.displayName}
          className={styles.avatar}
        />
      )}
      <h1 className={styles.name}>{user.displayName}</h1>
      <div className={styles.status}>
        <span className={styles.dot} />
        <span>待審核</span>
      </div>

      <p className={styles.message}>
        歡迎來到清心球場
        <br />
        <br />
        你的會員資格正在審核中
        <br />
        管理員確認身份後將開啟功能權限
      </p>

      <button className={styles.logoutButton} onClick={logout}>
        登出
      </button>
    </div>
  );
}
