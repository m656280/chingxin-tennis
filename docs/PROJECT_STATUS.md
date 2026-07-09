# PROJECT_STATUS.md — 清心網球系統現況

> 建立日期：2026-06-18
> 目的：正式營運階段的系統現況記錄，取代散落在 Dispatch 的零散知識。

---

## 一、系統架構總覽

```
使用者（LINE App）
    │
    ▼
LIFF（LINE Front-end Framework）
    │  liff.getAccessToken()
    ▼
issueFirebaseToken（Cloud Function）
    │  驗證 LINE Access Token → 查 members/{uid}.role/status
    │  回傳 Firebase Custom Token
    ▼
Firebase Auth（signInWithCustomToken）
    │  request.auth.uid = LINE userId
    │  request.auth.token.role / .status
    ▼
Firestore（Deta/firestore.rules）
    │  6 個 collections
    ▼
index.html（單檔 Monolith App）
    └─ UI + 全部邏輯（約 8,000+ 行）
```

---

## 二、Firebase 專案資訊

| 項目 | 值 |
|---|---|
| Firebase Project ID | `chingxin-tennis` |
| 正式網址 | `https://chingxin-tennis.web.app` |
| Hosting public 目錄 | `Deta/`（根目錄） |
| Functions Region | `asia-east1` |
| Firestore Region | `asia-east1`（預設） |
| Node.js Runtime（lineauth） | Node 24 |

---

## 三、部署方式

所有部署指令必須在 `Deta/` 目錄執行，且需先 `firebase use chingxin-tennis`。

```bash
# Hosting only（最常用）
firebase deploy --only hosting --project chingxin-tennis

# Functions only（lineauth codebase）
firebase deploy --only functions:lineauth --project chingxin-tennis

# Firestore Rules only（⚠️ 目前 v2 尚未 deploy）
firebase deploy --only firestore:rules --project chingxin-tennis

# 禁止：不加 --only（會同時動 Hosting + Functions + Rules）
# firebase deploy   ← 禁止
```

詳見 `docs/DEPLOY_GUIDE.md`。

---

## 四、Auth 現況

### 目前運作流程（雙軌並存）

**新流程（Firebase Auth）：**
1. LIFF 取得 LINE Access Token
2. POST `/issueFirebaseToken` → 驗證 LINE token → 讀 Firestore role/status → 回傳 Firebase Custom Token
3. `firebase.auth().signInWithCustomToken(token)` → `request.auth` 有值
4. Firestore v2 規則依 `request.auth.token.role/status` 做完整保護

**舊流程（sessionToken fallback）：**
1. LINE OAuth Callback → `lineCallback` Cloud Function（`lineauth` codebase）
2. `sessions/{randomToken}` 寫入 Firestore，帶 30 天過期
3. App 用 `?session=TOKEN` 參數讀取 session doc，取得 lineUserId
4. 不走 Firebase Auth，`request.auth = null`
5. 目前 v1 規則允許此流程（全開存取）

> ⚠️ 現有會員中，部分仍使用舊 sessionToken 流程。
> 部署 v2 Rules 後，這些用戶的舊 session 將失效，需重新登入。
> **現階段不強制重新登入，等待用戶自然 token 過期。**

---

## 五、Firestore Rules 現況

### 目前生產規則：v1.0-stopgap

- 檔案：`Deta/firestore.rules`
- 部署日期：2026-06-17
- 核心限制：**`request.auth` 恆為 null**（舊 session 流程無 Firebase Auth）
- 補償措施：資料形狀驗證（必填欄位、型別、枚舉值）
- **重大硬限制：規則內含 `request.time < timestamp.date(2026, 7, 1)` 條件**
  → **2026-07-01 00:00 後，所有 Firestore 操作自動被封鎖，網站全面失效**

### 草案：v2.0-draft

- 檔案：`Deta/firestore.rules.v2.draft`
- 狀態：✅ 44/44 PASS（Firestore Rules Playground 驗證）
- **尚未 deploy**
- 依賴：Firebase Auth Custom Token（`issueFirebaseToken` 已部署）
- 主要升級：
  - members 讀取限 auth 用戶（pending 只能讀自己）
  - bookings delete 限 owner
  - financialRecords 讀寫限 admin/owner
  - notifications 讀限本人（uid 比對）
  - announcements 寫限 admin/owner

### Firestore Collections

| Collection | 說明 |
|---|---|
| `members` | 用戶資料（uid = LINE userId） |
| `bookings` | 預約記錄（active/cancelled/void/auto_moved） |
| `financialRecords` | 財務記錄（annual/monthly/dayPass/coach/donate/expense） |
| `announcements` | 公告（含團課自動公告） |
| `notifications` | 個人通知 |
| `sessions` | lineCallback 建立的舊 session token（Admin SDK 寫入） |
| `duplicateIgnorePairs` | 財務重複比對例外名單 |

---

## 六、線上核心檔案

| 檔案 | 角色 | 注意 |
|---|---|---|
| `Deta/index.html` | **整個 App（UI + 邏輯 + DB）** | 🔴 線上唯一主程式 |
| `Deta/firebase.json` | Hosting / Functions 部署設定 | 🔴 不可隨意修改 |
| `Deta/.firebaserc` | 指定 project `chingxin-tennis` | 🔴 不可隨意修改 |
| `Deta/firestore.rules` | 目前生產規則（v1.0-stopgap） | 🔴 7/1 前必須升級 |
| `Deta/lineauth/index.js` | lineCallback + issueFirebaseToken | 🔴 已部署，修改需重新 deploy |
| `Deta/manifest.json` | PWA manifest | 🟡 次要 |
| `Deta/apple-touch-icon.png` | App 圖示 | 🟡 次要 |
| `Deta/public/og-preview.png` | 社群分享圖 | 🟡 次要 |

---

## 七、非線上檔案（可忽略）

| 路徑 | 性質 |
|---|---|
| `Deta/src/` | 凍結的 React/Vite 版本（Phase 1），最後動 2026-05-19，從未部署 |
| `Deta/_legacy/` | 最早的 Court Board 純 HTML 原型 |
| `Deta/functions/` | Cloud Functions 預留位（index.js 只有註解，無已部署函式） |
| `Deta/scripts/` | 一次性資料遷移腳本（2026-06-05 執行的 overlap-phase2-write） |
| `Deta/src/_unused/` | 連 React 版自己都廢棄的 HomeScreen 元件 |

---

## 八、已知風險

### 🚨 P0：Firestore Rules v1 到期（硬限）

- **截止時間：2026-07-01 00:00**
- 若未在此之前部署 v2 規則，所有 Firestore 操作被封鎖，網站全面失效
- 解法：參見 `docs/DEPLOY_GUIDE.md` 的 Rules Deploy 步驟
- 建議部署時間：**2026-06-29（最晚）**，留 buffer 處理異常

### 🟠 P1：現有用戶使用舊 sessionToken

- 舊 session 無 Firebase Auth token，v2 Rules 部署後需重新登入
- 解法：部署 v2 前透過 LINE 通知用戶，或等待用戶 token 自然過期
- **不強制重新登入，等用戶自然更新**

### 🟡 P2：financialRecords 目前全開讀寫

- v1 Rules 無身份驗證，任何知道 Firestore project ID 的人可讀取財務資料
- 解法：部署 v2 Rules（financialRecords 改為 isAdmin 才能讀寫）

### 🟡 P3：index.html 是單檔 monolith（約 8,000+ 行）

- 修改難度高，每次改動都需完整測試
- 任何語法錯誤都會導致整個 App 白屏
- 解法：嚴格遵守 `docs/DEPLOY_CHECKLIST.md`

---

## 九、下一步規劃

詳見 `docs/NEXT_PHASE.md`。

---

*清心網球系統 / chingxin-tennis — 由 Claude Cowork 建立 2026-06-18*
