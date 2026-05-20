/**
 * AuthContext — Phase 1
 *
 * 負責：
 * - LIFF 初始化
 * - 取得 LINE profile
 * - 確保 user document 存在
 * - 訂閱 user document 變化
 * - 提供 login / logout
 *
 * 不負責：Firebase Auth 整合（Phase 2 補）。
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';

import { initLiff, liff } from '../lib/liff';
import { ensureUserDocument, subscribeToUser } from '../services/userService';
import type { User } from '../types/user';

interface AuthContextValue {
  /** 初始化中（LIFF init + Firestore 首筆載入） */
  loading: boolean;
  /** 是否已透過 LIFF 登入 */
  isLoggedIn: boolean;
  /** Firestore user document（null = 尚未載入或登出狀態） */
  user: User | null;
  /** 觸發 LIFF login（會跳轉至 LINE 登入頁） */
  login: () => void;
  /** 登出 LIFF，並重新載入頁面 */
  logout: () => void;
  /** 初始化錯誤訊息 */
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        await initLiff();
        if (cancelled) return;

        if (!liff.isLoggedIn()) {
          setIsLoggedIn(false);
          setLoading(false);
          return;
        }

        setIsLoggedIn(true);

        const profile = await liff.getProfile();
        if (cancelled) return;

        await ensureUserDocument({
          userId: profile.userId,
          displayName: profile.displayName,
          lineAvatar: profile.pictureUrl ?? '',
        });
        if (cancelled) return;

        unsubscribe = subscribeToUser(profile.userId, (u) => {
          setUser(u);
          setLoading(false);
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[AuthContext] init error:', e);
        setError(msg);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const login = () => {
    liff.login();
  };

  const logout = () => {
    try {
      liff.logout();
    } finally {
      window.location.reload();
    }
  };

  return (
    <AuthContext.Provider
      value={{ loading, isLoggedIn, user, login, logout, error }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必須在 <AuthProvider> 內使用');
  }
  return ctx;
}
