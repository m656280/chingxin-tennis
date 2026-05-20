/**
 * LIFF SDK wrapper.
 *
 * 把 LIFF 初始化的副作用集中在這裡，
 * 其他地方 import { liff, initLiff } 就好。
 */

import liff from '@line/liff';

let initPromise: Promise<void> | null = null;

/**
 * 初始化 LIFF（idempotent）。
 * 多次呼叫只會初始化一次，回傳同一個 promise。
 */
export function initLiff(): Promise<void> {
  if (initPromise) return initPromise;

  const liffId = import.meta.env.VITE_LIFF_ID;
  if (!liffId) {
    return Promise.reject(new Error('VITE_LIFF_ID 未設定。請檢查 .env'));
  }

  initPromise = liff.init({ liffId }).catch((err) => {
    initPromise = null; // 失敗後允許重試
    throw err;
  });

  return initPromise;
}

export { liff };
