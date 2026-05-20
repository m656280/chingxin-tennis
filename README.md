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
