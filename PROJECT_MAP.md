# PROJECT_MAP.md — 清心網球系統專案地圖

> 整理日期：2026-06-04
> 本文件為「唯讀整理」，不修改任何程式碼。目的：取代散落在 Dispatch 的零散知識。

---

## 一句話總結

**整個線上系統 = 一個檔案：`Deta/index.html`（420 KB，約 8,371 行）。**
其他絕大多數資料夾（`src/`、`_legacy/`、`functions/`、`lineauth/`）都是**沒有實際上線**的歷史產物或預留位。判斷專案現況時，先看 `index.html`，其餘可暫時忽略。

---

## 1. 部署真相（最重要，先看這段）

部署設定在 `Deta/firebase.json`：

- `hosting.public = "."` → 以 **Deta 資料夾根目錄**為網站根目錄。
- `rewrites: ** → /index.html` → 所有路徑都導到 `index.html`（SPA 模式）。
- `hosting.ignore` 排除了 `src/**`、`dist/**`、`_legacy/**`、`*.ts`、`*.tsx`、`*.md`、`functions/**` 等。

**結論：實際被瀏覽器載入的就是根目錄那一支 `index.html`。**
`src/` 那套 React / Vite 程式（README 描述的「Phase 1」）**從未被部署**，已凍結在 5/19。

- Firebase 專案 ID：`chingxin-tennis`
- 正式網址：`https://chingxin-tennis.web.app`
- 最後修改 `index.html`：2026-06-04（持續開發中）

---

## 2. 正在上線使用的檔案（動到要非常小心）

| 檔案 | 角色 | 狀態 |
|---|---|---|
| `Deta/index.html` | **整個 App**：UI + 所有邏輯 + Firebase 存取，單檔 monolith | 🔴 線上核心 |
| `Deta/firebase.json` | Hosting / Functions 部署設定 | 🔴 線上設定 |
| `Deta/.firebaserc` | 指定專案 `chingxin-tennis` | 🔴 線上設定 |
| `Deta/manifest.json` | PWA manifest | 🟡 線上（次要） |
| `Deta/apple-touch-icon.png`、`Deta/icon.svg` | App 圖示 | 🟡 線上（次要） |
| `Deta/public/og-preview.png`、`public/icon*.svg` | 社群分享圖、圖示 | 🟡 線上（次要） |

> `index.html` 內透過 CDN 載入兩個外部 SDK：
> - LINE LIFF SDK：`https://static.line-scdn.net/liff/edge/2/sdk.js`
> - Firebase v9 compat SDK（在 `<head>` 內初始化，`projectId: chingxin-tennis`）

---

## 3. Prototype / Preview / Demo / Backup（沒有上線，可忽略或日後清理）

| 路徑 | 性質 | 說明 |
|---|---|---|
| `Deta/src/**` | **凍結的 React 版本** | README 講的 Vite+React+TS「Phase 1」。最後動 5/19，未部署。整套 `components/`、`screens/`、`services/`、`contexts/` 都屬於這版。 |
| `Deta/src/_unused/` | 廢棄元件 | 連 React 版自己都標記不用（HomeScreen）。 |
| `Deta/_legacy/` | **最早的 Court Board 原型** | 純 HTML/CSS/JS（`main.js` 111 KB）。`_legacy/README.md` 自述「舊原型，僅供參考」。 |
| `Deta/Deta_Phase3_Preview.html` | 設計預覽稿 | ⚠️ **注意：此檔目前被部署到線上**（見風險文件 A 段）。 |
| `Deta/Deta_Data_Model.md` | 舊設計文件 | 5/19 的資料模型草稿，與現況已脫節，以本次 `DATA_MODEL.md` 為準。 |
| `Deta/Deta_System_Architecture.md` | 舊架構文件 | 5/18 草稿，描述的是 React 版架構，非現況。 |
| `Deta/README.md` | 舊 README | 描述 React「Phase 1」，**與線上實況不符**，閱讀時請小心被誤導。 |
| `Deta/functions/` | Cloud Functions（預留） | `index.js` 只有註解與註解掉的範例，**沒有任何已部署函式**。 |
| `Deta/lineauth/` | LINE OAuth 後端（未使用） | 完整實作了一套 server-side 登入，但指向**另一個舊專案 `court-board-c1e29`**，線上 App 沒有用它（線上用前端 LIFF）。 |
| `Deta/.claude/worktrees/` | Claude 工作分支殘留 | 開發工具產生的暫存 worktree，可清理。 |
| `Deta/.fuse_hidden0000000b00000001` | 檔案系統殘留 | 雲端硬碟同步殘留檔，可忽略。 |
| 各層 `node_modules/` | 套件 | 不進版控、不部署。 |

---

## 4. 目錄結構（精簡版）

```
qingxin-club-system/
└─ Deta/                         ← 專案實際根目錄
   ├─ index.html        🔴 線上唯一主程式（UI+邏輯+DB）
   ├─ firebase.json     🔴 部署設定
   ├─ .firebaserc       🔴 專案：chingxin-tennis
   ├─ manifest.json / icon.svg / apple-touch-icon.png   🟡 PWA
   ├─ public/           🟡 og-preview.png、icon*.svg
   │
   ├─ src/              ⚪ 凍結的 React 版（未部署）
   │  ├─ components/ screens/ services/ contexts/ lib/ types/ utils/ styles/
   │  └─ _unused/      ⚪ 廢棄元件
   ├─ _legacy/          ⚪ 最早 Court Board 原型
   ├─ functions/        ⚪ Cloud Functions 預留（空殼）
   ├─ lineauth/         ⚪ LINE OAuth 後端（指向舊專案，未使用）
   │
   ├─ Deta_Phase3_Preview.html      ⚪ 預覽稿（誤被部署）
   ├─ Deta_Data_Model.md            ⚪ 舊文件
   ├─ Deta_System_Architecture.md   ⚪ 舊文件
   └─ README.md                     ⚪ 舊文件（描述未上線的 React 版）
```

🔴 線上核心　🟡 線上次要　⚪ 未上線 / 歷史產物

---

## 5. 後端服務各自負責什麼

| 服務 | 現況 | 負責內容 |
|---|---|---|
| **Firebase Hosting** | ✅ 使用中 | 託管 `index.html` 與靜態資源，網址 `chingxin-tennis.web.app`。 |
| **Firestore** | ✅ 使用中 | 唯一資料庫。前端（index.html）**直接讀寫**。collections：`members`、`bookings`、`financialRecords`、`announcements`、`notifications`。 |
| **LINE LIFF** | ✅ 使用中 | 登入認證。前端用 `liff.init` → `liff.getProfile()` 取得 LINE userId 當作 `members/{uid}` 文件 ID。LIFF ID：`2010122854-usyGQhHI`。 |
| **Firebase Auth** | ❌ 未整合 | 完全沒用。登入只靠 LIFF，Firestore 沒有 `request.auth`，目前推測規則為開放模式（見風險文件）。 |
| **Cloud Functions（functions/）** | ❌ 空殼 | 只有預留註解，無部署。 |
| **Cloud Functions（lineauth/）** | ❌ 未使用 | 一套 server-side LINE OAuth，但寫死舊專案 `court-board-c1e29`，線上沒接。 |
| **Supabase** | — | 專案中**完全沒有** Supabase。（任務清單有列，但實際未使用。） |

---

## 6. 給未來維護者的三個提醒

1. **只有 `index.html` 是真的。** 改任何東西前先確認是不是在這支檔案裡。`src/` 看起來很完整很誘人，但改了不會上線。
2. **`README.md` 會誤導你。** 它寫的是 React 版的故事，跟線上跑的單檔架構不同。以本資料夾四份文件為準。
3. **commit 訊息是 `oh00xx` 流水號**（oh0060…oh0072），看不出每次改了什麼。要追歷史得逐筆 diff，這也是「知識散落」的根源之一。

---

> 後續資料結構、權限、現況與風險，見 `DATA_MODEL.md`、`PERMISSION_RULES.md`、`CURRENT_STATUS.md`。
