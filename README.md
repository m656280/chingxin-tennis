# Deta

清心球場營運管理系統

---

## 階段

**Phase 1: Auth & Roles Skeleton** ← 目前階段

僅包含登入、user document 建立、角色分流。Booking、Finance、Calendar 等功能將於後續階段建立。

## 技術棧

- Vite + React 18 + TypeScript
- Firebase v10 (Firestore；Auth 預留至 Phase 2 整合)
- @line/liff v2
- CSS Modules + CSS Variables（無 CSS Framework）

## 檔案結構

```
Deta/
├─ src/
│  ├─ lib/                 # 第三方 SDK 初始化
│  ├─ services/            # Firestore 讀寫
│  ├─ contexts/            # React Context
│  ├─ types/               # TypeScript 型別
│  ├─ components/          # 共用元件
│  ├─ screens/             # 畫面 + co-located CSS module
│  ├─ styles/              # 全域樣式 + design token
│  ├─ App.tsx
│  └─ main.tsx
├─ _legacy/                # 舊 Court Board 原型，僅供參考
├─ Deta_System_Architecture.md
├─ Deta_Data_Model.md
└─ ...config files
```

## 設定

### 1. Firebase

到 [Firebase Console](https://console.firebase.google.com/) 建立專案：

- 啟用 **Firestore Database**（先選測試模式，Phase 2 補上 Security Rules）
- 加入 Web App，複製 config

### 2. LIFF

到 [LINE Developers Console](https://developers.line.biz/console/)：

- 建立 **LINE Login Channel**（Provider 可沿用既有的）
- Channel 內新增 **LIFF App**
  - Size：Full
  - Endpoint URL：開發時可填 ngrok 或 LIFF Inspector URL
  - Scope：勾選 `profile`、`openid`
- 複製 **LIFF ID**

### 3. 環境變數

```bash
cp .env.example .env
# 填入 Firebase config 與 LIFF ID
```

### 4. 安裝與啟動

```bash
npm install
npm run dev
```

## 認證模型（Phase 1）

目前採 **LIFF-only**：
- LINE userId 直接作為 Firestore `users` 文件 ID
- Firebase Auth 尚未整合（Phase 2 補 Cloud Function 交換 Custom Token）
- Firestore 暫時開放讀寫，**不可部署至 production**

## 畫面流程

```
loading                  → "載入中"
not logged in            → LoginScreen
logged in + first time   → 自動建立 user (role=pending)
logged in + pending      → PendingScreen
logged in + other role   → HomeScreen（顯示頭像 + 名稱 + 角色）
```

## 測試 Pending 流程

1. 首次登入 → 自動建立 `users/{lineUserId}`，role 預設 `pending`
2. 到 Firebase Console 把該文件的 `role` 改成 `owner` / `admin` / `annual_member` 等
3. 重新整理頁面 → 進入 HomeScreen

## 後續階段

- **Phase 2**：Firebase Auth Custom Token + Security Rules
- **Phase 3**：Calendar Layer + Booking System
- **Phase 4**：Finance + Annual Report
- **Phase 5**：Coach ↔ Student 連結 + clay_access 授權

每個 Phase 獨立 PR，不跨階段混合。

---

## Root Cause First Policy

遇到 Bug 時，禁止直接實作修復。必須依序：

1. **找出 Root Cause** — 定位問題的真正來源，不靠猜測
2. **說明影響範圍** — 確認此問題影響哪些功能、資料、使用者
3. **提出修復方案** — 說明如何修、為什麼這樣修
4. **再進行修改**

禁止：

- 猜測修復
- 疊補丁（在舊問題上加條件繞過）
- 複製相似程式碼湊合
- 為了通過測試而修改業務邏輯

修復後必須回報：

- Root Cause
- 修改檔案
- 測試結果

---

## Low Risk Change Policy

若符合以下所有條件：

- 僅修改 UI
- 不修改 Firestore Schema
- 不修改權限
- 不修改財務計算邏輯
- 不修改預約規則
- 不刪除資料
- 可輕易回滾

則 Claude 直接實作，不詢問：

- 「可以修改嗎？」
- 「要開始動工嗎？」
- 「是否繼續？」

完成後直接回報：

- 修改內容
- 測試結果
- Commit Message
- Deploy 指令

---

## Autonomous UI Improvement Policy

對於以下類型修改：

- UX 改善
- UI 優化
- Admin 工具優化
- 財務管理介面優化
- 會員管理介面優化
- 預約管理介面優化
- 報表與匯出功能優化

若符合以下條件：

1. 不修改 Firestore Schema
2. 不修改資料結構
3. 不修改權限邏輯
4. 不修改會員身份判斷
5. 不修改財務計算公式
6. 不修改預約規則
7. 不刪除任何資料
8. 修改檔案數量 <= 3

則 Claude 可直接：

Analyze → Implement → Test → Report

不需等待使用者批准。

完成後請回報：
- 修改檔案
- 修改內容
- 測試結果

若涉及以下項目，仍需先取得批准：

- Firestore Schema
- Firebase Rules
- 權限系統
- LINE Login
- 財務計算邏輯
- 預約規則
- 資料刪除
- 外部 API
- 付費功能

---

## Deployment Policy

Claude 完成功能後，必須輸出以下四項。目標是讓使用者只需複製貼上執行，不需要自行分析 Git 或 Firebase 狀態。

### 1. Commit Message

直接提供可複製的格式，例如：

```
feat: add finance export range modal
```

### 2. Git Status 預期結果

列出這次修改預期會出現在 `git status` 的檔案，讓使用者對照確認，例如：

```
modified:   index.html
```

若有多個檔案，逐一列出。使用者確認一致後再執行後續指令。

### 3. Deploy 指令

提供完整、可直接貼入 Terminal 的指令區塊，包含：

- `cd` 到正確目錄
- `git add` 指定檔案（不使用 `git add .`）
- `git commit -m`
- `git push`
- `firebase deploy`

範例：

```bash
cd "/Users/m656280/Library/CloudStorage/Dropbox/MK's AI Agent/2026/qingxin-club-system/Deta"
git add index.html
git commit -m "feat: add finance export range modal"
git push
firebase deploy --only hosting
```

若涉及 Firebase project 或 hosting target，一併提醒：

```bash
# 確認 Firebase project
firebase use
# 預期應顯示：chingxin-tennis

# 若需指定 target
firebase deploy --only hosting:chingxin-tennis
```

### 4. 手機驗收清單

完成部署後，提供具體的手機測試步驟，格式如下：

```
部署網址：https://chingxin-tennis.web.app

手機驗收：
- [ ] <測試項目 1>
- [ ] <測試項目 2>
- [ ] <測試項目 3>
```

### 規則

- 不說「請自行 commit」或「請自行 deploy」
- 不要求使用者判斷 Git 狀態或 Firebase 設定
- 若沙盒無法執行 git / firebase，Claude 說明限制並直接提供使用者端指令，不要求使用者排查
- 若遇到 worktree 錯誤、CLI 缺失等環境問題，在 Report 段落說明，使用者只看到可執行的最終指令
