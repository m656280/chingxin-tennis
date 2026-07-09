# DEPLOY_GUIDE.md — 清心網球系統部署手冊

> 建立日期：2026-06-18
> 適用環境：macOS，Firebase CLI 已安裝，已登入 `chingxin-tennis` 專案

---

## 前置確認

每次部署前先執行：

```bash
# 確認登入正確帳號
firebase login --list

# 確認指向正確專案
firebase use
# 預期輸出：Active Project: chingxin-tennis

# 若尚未切換
firebase use chingxin-tennis

# 確認工作目錄是 Deta/
pwd
# 預期輸出：...qingxin-club-system/Deta
```

---

## 1. Hosting Deploy（最常用）

當 `index.html`、`manifest.json`、圖示等靜態檔案有更新時執行。

```bash
cd /path/to/qingxin-club-system/Deta

firebase deploy --only hosting --project chingxin-tennis
```

**部署後驗證：**
- 開啟 `https://chingxin-tennis.web.app`（用手機的 LINE Browser）
- 確認場地頁正常顯示
- 確認 Console 無紅色錯誤（Chrome DevTools）

**部署時間：** 通常 1 分鐘內完成

---

## 2. Functions Deploy（lineauth）

當 `lineauth/index.js` 或 `lineauth/package.json` 有更新時執行。

目前有兩個 Cloud Functions：
- `lineCallback`：LINE OAuth 2.0 Callback，建立 sessions + members
- `issueFirebaseToken`：發行 Firebase Custom Token（已部署，運作中）

```bash
cd /path/to/qingxin-club-system/Deta

# 只 deploy lineauth codebase
firebase deploy --only functions:lineauth --project chingxin-tennis
```

**注意：**
- `functions/` 目錄下沒有任何已部署函式（只有預留位），**不需要 deploy**
- 若誤執行 `firebase deploy --only functions`（不指定 codebase），會同時 deploy 兩個 codebase

**部署後驗證：**
- Cloud Logging 查看 `lineCallback` / `issueFirebaseToken` 是否有新的 log
- 用 LINE 重新登入，確認流程正常

---

## 3. Firestore Rules Deploy

### ⚠️ 目前狀態

- 生產中：`firestore.rules`（v1.0-stopgap，**2026-07-01 到期**）
- 草案：`firestore.rules.v2.draft`（44/44 PASS，**尚未 deploy**）

### 部署 v2 Rules 步驟

**執行時機：** 2026-06-29 之前（最晚）

```bash
cd /path/to/qingxin-club-system/Deta

# Step 1: 備份現有規則
cp firestore.rules firestore.rules.v1.stopgap.backup

# Step 2: 複製草案為正式規則
cp firestore.rules.v2.draft firestore.rules

# Step 3: 僅部署 Rules（不動 Hosting / Functions）
firebase deploy --only firestore:rules --project chingxin-tennis
```

**部署後觀察（部署完的 30 分鐘內）：**
- Cloud Logging 確認無大量 `PERMISSION_DENIED`
- 用有效的 active 帳號確認：可讀取預約、可看場地、可進財務頁（admin）
- 確認 pending 帳號只能看到自己的審核狀態

### 注意事項

- **絕對不要**執行 `firebase deploy`（不加 `--only`）
  - 會同時 deploy Hosting + Functions + Rules，風險大
- v2 部署後，持有舊 sessionToken 的用戶（無 Firebase Auth）讀取 `members` 會被拒
  - 用戶需重新點選 LINE 登入，走 LIFF → issueFirebaseToken 新流程
  - 這是預期行為，不會損失資料

---

## 4. Rollback 流程

### Hosting Rollback

```bash
# 查看 Hosting 版本清單
firebase hosting:channel:list --project chingxin-tennis

# 回復到上一個版本（從 Firebase Console 操作更直覺）
# Console → Hosting → 版本歷史 → 點選「重新部署」
```

### Firestore Rules Rollback（最重要）

**觸發條件（任一出現立即執行）：**
- Active 用戶回報無法讀取場地預約或會員列表
- 財務頁出現 Permission Denied（admin 帳號 token claims 異常）
- Cloud Logging 出現大量 `PERMISSION_DENIED`（正常只有 pending 用戶會被拒）
- 任何用戶無法建立或取消預約

```bash
# 方式 A：從備份還原（推薦）
cp firestore.rules.v1.stopgap.backup firestore.rules
firebase deploy --only firestore:rules --project chingxin-tennis

# 方式 B：直接寫回臨時規則（v1 已到期時的緊急用）
cat > firestore.rules << 'EOF'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
EOF
firebase deploy --only firestore:rules --project chingxin-tennis
```

> 方式 B 是最寬鬆的緊急規則（全開），僅在緊急情況下使用，解決問題後立即重新部署 v2。

### Functions Rollback

```bash
# Firebase Console → Functions → 查看舊版本（無法直接回滾）
# 實際做法：git checkout 到上一個 commit → 重新 deploy functions
git log --oneline lineauth/index.js
git checkout <commit-hash> -- lineauth/index.js
firebase deploy --only functions:lineauth --project chingxin-tennis
```

---

## 5. 禁止執行的指令

```bash
# ❌ 禁止：不加 --only，會同時改動所有服務
firebase deploy

# ❌ 禁止：在未確認 project 的情況下 deploy
firebase deploy --only hosting   # 先執行 firebase use 確認

# ❌ 禁止：直接修改 Firestore Rules 不備份就 deploy
firebase deploy --only firestore:rules   # 必須先 cp 備份
```

---

## 6. 重要時間節點

| 日期 | 動作 |
|---|---|
| 2026-06-25 | 檢查 Cloud Logging，確認 `issueFirebaseToken` 有呼叫紀錄（用戶已走新流程） |
| 2026-06-28 | 若 v2 未部署，透過 LINE 群組通知用戶即將升級 |
| **2026-06-29（最晚）** | **執行 Firestore Rules v2 deploy** |
| 2026-07-01 | v1 規則到期（此時 v2 應已上線） |

---

*清心網球系統 / chingxin-tennis — 由 Claude Cowork 建立 2026-06-18*
