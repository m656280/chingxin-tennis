# Firestore Rules v2 — 暫緩 Deploy 歸檔

> 狀態：**暫緩** — 草案已完成、驗證通過，等待時機成熟再部署  
> 建立日期：2026-06-18  
> 最後更新：2026-06-18

---

## 目前狀態

| 項目 | 狀態 |
|------|------|
| Firebase Auth（Custom Token）整合 | ✅ 已完成，`issueFirebaseToken` 部署正常 |
| LINE Hosting | ✅ 已部署，`chingxin-tennis.web.app` 正常 |
| Firestore Rules v2 草案 | ✅ 已完成（`Deta/firestore.rules.v2.draft`） |
| Rules Playground 驗證 | ✅ **44 / 44 PASS**（2026-06-18） |
| Firestore Rules 生產環境 | ⏸️ **尚未 deploy**，仍維持 2026-07-01 臨時規則 |

---

## 1. 為什麼暫緩 Deploy

**核心原因：避免現有用戶被迫中斷體驗，重新登入。**

目前所有現有用戶都持有舊 `localStorage` session（在 `signInWithCustomToken` 整合完成之前建立的）。這些 session 不包含 Firebase Auth token，因此 `request.auth` 在 Firestore 端為 `null`。

若立即部署 v2 規則：

- v2 的 `members` 讀取規則要求 `request.auth != null`
- 舊 session 用戶進網站 → Firestore fallback 讀取被 DENY → 自動跳回登入頁
- 用戶需重新點選 LINE 登入，走完一次新流程

這是預期的技術行為，不會造成資料遺失，但會中斷用戶當下的使用體驗。

**決策：等待用戶自然重新登入（例如 token 過期、主動登出、換手機），不強制中斷。**

---

## 2. 何時可以 Deploy

滿足以下任一條件即可考慮部署：

### 條件 A（推薦）：確認現有用戶已自然重新登入
- Cloud Logging 出現至少 N 筆 `issued for: xxx` 記錄（N = 主要活躍用戶數）
- 代表這些用戶已走過新流程，Firebase Auth token 已就緒

### 條件 B：7/1 臨時規則到期前主動切換
- 臨時規則 `request.time < timestamp.date(2026, 7, 1)` 到期後，所有 Firestore 操作都會被封鎖
- **必須在 2026-07-01 之前完成 v2 部署**，否則網站全面失效
- 建議時間：**2026-06-28 ~ 2026-06-30**，保留緩衝時間處理異常

### 條件 C：低峰時段 + 提前通知用戶
- 透過 LINE 群組或公告事先告知：「系統將於 XX 日安全性升級，請重新登入一次」
- 選擇用戶活動最低的時段（深夜 00:00 ~ 06:00）執行

---

## 3. Deploy 前檢查

執行 deploy 前，逐項確認：

- [ ] **備份現有規則**：`cp firestore.rules firestore.rules.v1.stopgap.backup`
- [ ] **確認草案一致**：`Deta/firestore.rules.v2.draft` 未被修改（44/44 PASS 的版本）
- [ ] **Firebase CLI 版本正常**：`firebase --version`
- [ ] **已登入正確 project**：`firebase use chingxin-tennis`
- [ ] **Rollback 指令已複製備用**（見第 4 節）
- [ ] **已通知用戶**（或確認為低峰時段）
- [ ] **執行指令只 deploy rules**，不動 Functions / Hosting

### Deploy 指令（完整步驟）

```bash
# 在 Deta/ 目錄執行

# Step 1: 備份
cp firestore.rules firestore.rules.v1.stopgap.backup

# Step 2: 複製草案為正式規則
cp firestore.rules.v2.draft firestore.rules

# Step 3: 僅部署 Firestore Rules
firebase deploy --only firestore:rules --project chingxin-tennis
```

**禁止執行**：`firebase deploy`（不加 `--only`，會動到 Functions / Hosting）

---

## 4. Rollback 指令

部署後若出現異常（任何用戶回報無法預約、財務頁錯誤、大量登出），立即執行：

```bash
# 方式 A：直接寫回臨時規則（最快，約 30 秒生效）
cat > firestore.rules << 'EOF'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time < timestamp.date(2026, 7, 1);
    }
  }
}
EOF

firebase deploy --only firestore:rules --project chingxin-tennis

# 方式 B：從備份還原
cp firestore.rules.v1.stopgap.backup firestore.rules
firebase deploy --only firestore:rules --project chingxin-tennis
```

### Rollback 觸發條件（任一出現即立即執行）

- Active 用戶回報無法讀取場地預約或會員列表
- 財務頁出現 Permission Denied 錯誤（admin 帳號 token claims 未正確）
- Cloud Logging 出現大量 `PERMISSION_DENIED`（正常只有 pending 用戶被拒）
- 用戶無法建立或取消預約

---

## 5. 7/1 前提醒

> ⚠️ **硬性截止：2026-07-01 00:00（台灣時間）**

臨時規則 `request.time < timestamp.date(2026, 7, 1)` 在此時間後自動失效，屆時所有 Firestore 讀寫（包含 members、bookings、所有 collection）都會被 catch-all 規則封鎖，**網站全面無法使用**。

### 建議行動時間線

| 日期 | 動作 |
|------|------|
| 2026-06-25 | 檢查 Cloud Logging，確認 issueFirebaseToken 是否有實際呼叫紀錄 |
| 2026-06-28 | 若仍未 deploy，發送 LINE 群組通知，告知即將升級 |
| 2026-06-29（最晚） | 執行 v2 deploy，觀察 30 分鐘確認穩定 |
| 2026-07-01 | 臨時規則到期（此時應已 deploy v2，無影響） |

**不要等到 6/30 才 deploy**，保留至少 1 天的 buffer 處理意外。

---

## 相關檔案

| 檔案 | 說明 |
|------|------|
| `Deta/firestore.rules.v2.draft` | v2 規則草案（228 行，44/44 PASS，待 deploy） |
| `Deta/firestore.rules` | 目前生產規則（v1.0-stopgap，已非最新） |
| `Deta/p2_firestore_rules_v2_report.html` | P2+P3 驗證報告（含 44 個測試案例結果） |
| `Deta/p4_firestore_rules_v2_deploy_report.html` | P4 部署前收尾報告（含 deploy / rollback 指令、必測項目） |

---

*清心網球系統 / chingxin-tennis — 由 Claude Cowork 歸檔*
