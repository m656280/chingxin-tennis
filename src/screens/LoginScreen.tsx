import { useAuth } from '../contexts/AuthContext';
import { KnotLogo } from '../components/KnotLogo';
import styles from './LoginScreen.module.css';

export function LoginScreen() {
  const { login } = useAuth();

  return (
    <div className={styles.container}>
      <div className={styles.logoArea}>
        <KnotLogo size={56} />
        <div className={styles.brandText}>
          <h1 className={styles.brand}>CHING XIN</h1>
          <p className={styles.tagline}>Tennis Society</p>
        </div>
      </div>

      <button className={styles.loginButton} onClick={login}>
        以 LINE 登入
      </button>

      <p className={styles.note}>
        登入後系統會自動建立會員紀錄
        <br />
        新會員需經管理員審核後開放功能
      </p>
    </div>
  );
}
