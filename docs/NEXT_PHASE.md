# NEXT_PHASE.md — 下一階段規劃

> 建立日期：2026-06-18
> 範圍：從目前穩定的 Production 狀態，往前推進的優先序與方向建議。

---

## 一、現在不建議做的事

### ❌ 重構 index.html 為元件化架構

目前 App 是 8,000+ 行的單檔 monolith。雖然維護難度高，但系統已穩定上線、功能齊全。重構為 React/Vite 架構（`src/` 那套）涉及：
- 完整的功能重寫（不是遷移）
- 重新部署與測試流程
- 用戶有感的風險期

**時機**：等到 Firestore Rules v2 部署穩定、有明確的功能擴充需求時，再評估是否值得。

### ❌ 清除 `src/` 目錄

`src/` 是凍結的 React 版本，雖然未上線，但它包含完整的型別定義（`types/`）、服務層設計（`services/`）和元件架構，是未來重構時的參考藍本。不要貿然刪除。

### ❌ 修改 lineCallback Cloud Function

`lineCallback` 負責現有用戶的 sessionToken 建立，修改它可能影響舊 session 流程。在 v2 Rules 部署、確認所有用戶已遷移到 Firebase Auth 流程之前，不要動它。

### ❌ 新增大型功能

在 Firestore Rules v2 尚未部署、`request.auth` 尚未全面可靠之前，任何新功能都會建立在沒有身份驗證的基礎上。先完成 v2 部署，才是正確的新功能起點。

---

## 二、可立即執行的事

### ✅ 1. 部署 Firestore Rules v2（**最優先，截止 2026-06-29**）

條件已就緒：44/44 PASS，`issueFirebaseToken` 已部署。
唯一風險是現有舊 session 用戶需重新登入，可透過 LINE 通知緩解。

```bash
# 在 Deta/ 目錄執行
cp firestore.rules firestore.rules.v1.stopgap.backup
cp firestore.rules.v2.draft firestore.rules
firebase deploy --only firestore:rules --project chingxin-tennis
```

### ✅ 2. 清理根目錄（歸檔到 Archive/）

根目錄有 29 個 `.command` 腳本和 16 個 `.log` 檔案，全部是開發過程中的臨時工具。
詳見「五、歸檔建議清單」。

### ✅ 3. 確認 Cloud Logging 中 issueFirebaseToken 的使用量

登入 Firebase Console → Functions → issueFirebaseToken → 查看近 7 天 invocation count。
這個數字告訴你有多少用戶已走過新流程，對判斷 v2 部署的影響範圍很有幫助。

---

## 三、未來優化項目

按優先序排列：

### 🔵 Phase A：完成 Auth 現代化（近期）

**目標：** 讓所有用戶都使用 Firebase Auth，徹底移除 sessionToken fallback。

- 確認主要活躍用戶已自然走過 `issueFirebaseToken` 流程
- 部署 v2 Rules
- 部署後觀察 1–2 週，確認無異常
- 舊 `lineCallback`（sessionToken 流程）可考慮下線（但不急）

### 🔵 Phase B：前端 Auth 整合強化

`src/contexts/AuthContext.tsx` 目前還是舊的 LIFF-only 流程，沒有整合 Firebase Auth。
若未來要在 React 架構上開發新功能，需要：
- AuthContext 加入 `firebase.auth().onAuthStateChanged` 監聽
- `ensureUserDocument` 改用 Firebase Auth uid

### 🔵 Phase C：functions/ 預留功能補充

`functions/index.js` 預留了三個未實作函式：
1. `onNewMember`：新會員建立時通知 admin（via LINE Notify 或 FCM）
2. `expireMonthlyMemberships`：定期清理到期月費會員狀態（排程 function）
3. Admin 審核動作（approve/block/resign）的 server-side 版本

這些是「很有用但不急」的功能，不需要改 index.html。

### 🔵 Phase D：財務系統增強

- 月費自動到期提醒（目前已有「即將到期」提示，但需手動查看）
- 財務記錄 export 支援更多格式（目前有 CSV）
- 與 LINE Notify 整合，到期前自動推播給本人

### 🔵 Phase E：分析與監控

- Firebase Performance Monitoring（了解 App 在 LINE WebView 的載入速度）
- Firestore 用量監控（避免意外爆出超額費用）
- 設定 Firebase Alerts（Functions 錯誤率提醒）

---

## 四、架構選擇備忘

### 為什麼用 index.html monolith 而不是 React Build？

React build 需要 Vite bundler + CI 流程，每次修改都要 build 再 deploy。
目前 index.html 方式可以直接改完就 `firebase deploy --only hosting`，適合小規模快速迭代。

**切換回 React 的正確時機：**
- 需要多人協作開發（目前只有一人維護）
- 功能複雜度高到 monolith 難以維護
- 有完整的 staging + CI/CD 流程預算

### 為什麼 lineauth 和 functions 是兩個 codebase？

- `lineauth`：LINE OAuth，對外暴露 HTTP endpoint，需要 secrets（LINE_CHANNEL_SECRET）
- `functions`：Firebase Triggers / Admin 功能，將來可能用 Admin SDK 做 server-side 操作

分開管理可以避免 secrets 外洩到 functions codebase，也可以獨立 deploy。

---

## 五、歸檔建議清單

詳見下方「六」節。

---

## 六、根目錄清理建議

### 建議歸檔到 `Archive/`（不要刪除，移走就好）

**`.command` 腳本（29 個）：**

| 檔案 | 說明 |
|---|---|
| `p1_deploy.command` ~ `p1_deploy14.command` | 開發期間的 deploy 腳本（已有正式 `deploy.command`，這些是歷史版本） |
| `p1_debug_deploy.command` | Debug 用 deploy 腳本 |
| `p1_diagnose.command` ~ `p1_diagnose3.command` | 診斷腳本 |
| `p1_deploy_hosting.command` | Hosting-only deploy 舊版本 |
| `p1_fix_deploy.command` | 修復 deploy 問題的腳本 |
| `p1_spy_deploy.command` | 監視 deploy 過程的腳本 |
| `p1_test_loadstack.command` ~ `p1_test_loadstack4.command` | 測試 Firebase SDK 載入的腳本 |
| `p1_test_node.command` | 測試 Node.js 環境 |
| `fix_permissions.command` | 修復檔案權限 |
| `fix_xattr.command` | 修復 macOS extended attributes |

**保留的 `.command`：**
- `deploy.command`：最新的一鍵 deploy 腳本（保留）
- `deploy-now.sh`：如果是最新版 deploy 腳本（確認後決定）
- `release.sh`：確認功能後決定

**`.log` 檔案（16 個，全部可歸檔）：**
- `deploy10.log` ~ `deploy14.log`
- `deploy_hosting.log`
- `diagnose*.log`
- `firebase-debug.log`
- `firebase_deploy_debug.log`
- `index_diag.log`
- `loadstack_test*.log`
- `node_require_test.log`

**其他：**
- `diag_prefix.js`：診斷用臨時腳本，可歸檔
- `test_manifest4.json`：manifest 測試用，可歸檔
- `截圖 2026-05-18 下午5.15.47.png`：開發時截圖，可歸檔

### 建議保留在根目錄

| 檔案 | 原因 |
|---|---|
| `index.html` | 線上唯一主程式 |
| `firebase.json` | 部署設定 |
| `.firebaserc` | 專案設定 |
| `firestore.rules` | 目前生產規則 |
| `firestore.rules.v2.draft` | 待部署草案，不可移走 |
| `firestore.indexes.json` | Firestore 索引設定 |
| `manifest.json` | PWA manifest |
| `logo.png`, `apple-touch-icon.png` | App 圖示 |
| `og-use.png` | 社群分享圖 |
| `deploy.command` | 最新部署腳本 |
| `deploy-now.sh` | 確認後決定 |
| `release.sh` | 確認後決定 |
| `tsconfig.json`, `vite.config.ts`, `package.json` | React 版構建設定（凍結中，保留備用） |

### scripts/ 目錄

| 檔案 | 建議 |
|---|---|
| `overlap-dryrun.mjs` | 一次性資料遷移腳本（已執行），可歸檔 |
| `overlap-phase2-write.mjs` | 已執行的寫入腳本，可歸檔 |
| `overlap-dryrun-result.json` | 遷移結果，可歸檔 |
| `run-phase2-once.html` | 一次性執行頁面，可歸檔 |

---

*清心網球系統 / chingxin-tennis — 由 Claude Cowork 建立 2026-06-18*
