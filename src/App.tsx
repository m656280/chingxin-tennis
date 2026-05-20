/**
 * App — Phase 1 routing
 *
 * 不使用 React Router；以 auth state 直接條件渲染。
 * Phase 3 加入 Calendar / Booking 後再評估是否導入 React Router。
 */

import { useAuth } from './contexts/AuthContext';
import { LoginScreen } from './screens/LoginScreen';
import { PendingScreen } from './screens/PendingScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { ROLES } from './types/role';

export function App() {
  const { loading, isLoggedIn, user, error } = useAuth();

  if (error) {
    return <ErrorView message={error} />;
  }

  if (loading) {
    return <LoadingView />;
  }

  if (!isLoggedIn) {
    return <LoginScreen />;
  }

  // logged in but no user document yet (race condition / first time)
  if (!user || user.role === ROLES.PENDING) {
    return <PendingScreen />;
  }

  return <CalendarScreen />;
}

/* --- Minimal inline views (loading / error) --- */
/* 不另開檔，因為這兩個只在最外層使用，不會被其他畫面 reuse */

function LoadingView() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        letterSpacing: '0.2em',
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
      }}
    >
      Loading
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 16,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: '0.2em',
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
        }}
      >
        系統載入失敗
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          maxWidth: 320,
          lineHeight: 1.7,
        }}
      >
        {message}
      </div>
    </div>
  );
}
