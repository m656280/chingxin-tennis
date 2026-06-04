# CURRENT_STATUS.md — 清心網球系統現況

> 整理日期：2026-06-04
> 範圍：以線上實際檔案 `Deta/index.html` 為準。本文件不修改任何程式。

---

## 一、已完成功能（線上可用）

**認證**
- LINE LIFF 登入，LINE userId 當 `members` 文件 ID。
- 首次登入自動建檔（pending），localStorage 快取 uid 做快速 resume。
- 外部瀏覽器引導「請用 LINE 開啟」、ID Token fallback。

**預約系統**
- 週 / 日 / 月三種視圖，現在時間線、場地表面（硬地/紅土）切換。
- 5 種預約模式：一般、匹克球、教學、團課、活動鎖場。
- 4 片場地、依國定假日 / 寒暑假自動套用不同開放時段。
- 併場/加入邏輯、跨場時間衝突偵測、容量上限。
- 取消 / 作廢（void）/ 永久刪除，取消原因、通知相關人。
- 一般預約可帶球友（會員）與訪客（純姓名）。

**會員管理**
- 待審核核准 / 拒絕 / 重新開放、離會 / 封鎖 / 解封 / 恢復 / 永久刪除。
- 角色切換（member/coach/admin），admin 上限 8、owner 保護。
- 編輯正式姓名、NTRP、慣用位置。

**財務系統**
- 年費 / 月費 / 抖內 / 支出四類紀錄，依年度切換。
- 結餘、各類統計卡、圓餅圖、即將到期會員提醒。
- 作廢 / 退費 / 刪除，CSV 匯出。
- 寫入年/月費時自動回算並回寫會籍到期日。

**教練功能**
- 教練↔學生指派（`coachStudents` map），出席 / 繳費 / 備註。
- 教學預約點名（attendance）。

**其他**
- 公告（含團課自動公告、系統公告）。
- 個人通知中心（預約被取消/作廢）。
- PWA（manifest、圖示、可加到主畫面）。

---

## 二、預約系統資料流

```
使用者填表 (openBookingForm)
   │  formCourt/Date/Start/End/Mode/Capacity/Coach/students/buddies
   ▼
submitBooking()
   ├─ 前端權限檢查（紅土/團課/活動 → 需 admin；教學需 coach）
   ├─ 開放時段檢查 getCourtOpenHours()
   ├─ 查同場同時段既有預約 bookings.where(court,date,startTime,endTime)
   │     ├─ 獨占模式衝突 → 擋
   │     ├─ 同模式可加入 → arrayUnion(players) + increment(participantCount)
   │     └─ 不同模式 → 擋
   ├─ 跨場參與者時間衝突 hasParticipantTimeConflict()
   └─ bookings.add(newDoc)  status:'active'
         │
         ├─ groupClass → _createGroupClassAnnouncement() 寫 announcements
         └─ 失效本地快取 → loadWeekBookings / loadMyBookings / loadMonthBookings 重抓

取消流程：
cancelBooking / voidBooking → _executeCancel/_executeVoid
   → bookings.update(status) → _sendBookingNotifications() 寫 notifications 給相關人
```

讀取快取：`courtBookingsFirestore`、`weekBookingsCache`、`monthBookingsCache`、`allBookingsCache`、`myBookingsFirestore`。寫入後設為 null 強制重抓。

---

## 三、財務系統資料流

```
管理員填表 (openFinanceForm，僅 isAdminLike 看得到入口)
   ▼
submitFinanceRecord()
   ├─ type=annual/monthly → _calcMembershipExpiry() 算到期日
   ├─ financialRecords.add(rec)  status:'active'
   │     並 snapshot 會員 displayName/realName（防會員被刪）
   └─ 若年/月費 → members/{memberId}.update({membershipType, membershipExpiry, expireDate})
         （members 上的會籍只是顯示快取）

會費狀態判定 _calcMemberFeeStatus(member)：
   只認 financialRecords 中 status==='active' 的年/月費
   → 取到期日最晚那筆 → 已繳清 / 即將到期 / 已到期 / 尚未繳費

報表：renderFinance → 結餘、統計卡、圓餅圖、即將到期清單
匯出：exportFinanceCSV → 前端組 CSV 下載
作廢/退費：status 改 void/refund（會被會費判定排除）
```

> 真實來源 = `financialRecords`；`members` 的會籍欄位是衍生快取。兩者若不同步，以 financialRecords 為準。

---

## 四、已知問題 / 風險

1. **Firestore Rules 狀態不明、疑似全開放**（最高風險，見第六段 A-1）。
2. **`.git/` 整個資料夾疑似被部署到公開網站**（見 A-2）。
3. **`Deta_Phase3_Preview.html` 被部署到線上**，可被任意存取。
4. **單檔 8,371 行 monolith**：所有邏輯擠在 `index.html`，無模組、無測試，改動風險高、衝突難追。
5. **commit 訊息全是 `oh00xx` 流水號**，無法從歷史看出每次改了什麼。
6. **狀態值不一致**：`active`/`approved` 並存、`deleted`/`removed`/`expired`/`inactive` 混用、`membershipExpiry`/`expireDate` 兩欄並存。
7. **無後端驗證**：所有權限只在前端，未整合 Firebase Auth。
8. **快取手動失效**：靠手動設 null 重抓，多分頁/多人同時操作可能看到舊資料（非即時 onSnapshot）。
9. **訪客以「姓名字串」存**，無法防重名、無法統計。
10. **三套並存的程式**（index.html / src React / _legacy）容易讓人改錯地方。

---

## 五、待開發 / 技術債

**待開發（功能面）**
- 真正的「財務專責角色」（目前 finance 只是 admin 的分頁）。
- 後端 Cloud Functions：會籍到期自動失效、新會員通知管理員（`functions/index.js` 已留註解範例）。
- 即時同步（onSnapshot）取代手動快取失效。
- LINE 主動推播（目前 notifications 只存 Firestore，未發 LINE 訊息）。

**技術債（結構面）**
- 把 monolith 拆模組，或正式採用已凍結的 `src/` React 版（二擇一，別三套並存）。
- 收斂狀態列舉值、欄位命名。
- 補 Firestore Rules + Firebase Auth 並納入版控。
- 清掉 `_legacy/`、`.claude/worktrees/`、`.fuse_hidden*`、誤部署的預覽稿。
- commit 訊息規範化。

---

## 六、A. 最危險、最容易被誤改的地方

> 依「改錯的後果嚴重程度」排序。

**A-1（最高）：Firestore 安全規則 — 不在版控、疑似全開放**
- 專案無 `firestore.rules`、`firebase.json` 無 rules 區塊、未整合 Firebase Auth、README 自承「暫時開放讀寫」。
- 若真為測試模式，等於資料庫對外裸奔（個資、財務、可自改 role 成 owner）。
- 👉 **請先去 Firebase Console → Firestore → Rules 確認實際內容**。這是全系統第一優先。（本次不修。）

**A-2：`.git/` 與預覽稿疑似被公開部署**
- `firebase.json` 的 `hosting.public='.'` 把整個 Deta 目錄當網站根目錄。
- ignore 規則 `**/.*` **只擋第一層 dotfile，擋不掉巢狀的 `.git/objects/...`**；部署快取 `.firebase/hosting..cache` 中確實列出大量 `.git/...` 與 `Deta_Phase3_Preview.html`。
- 風險：原始碼全歷史、任何曾 commit 的金鑰，可能可從 `chingxin-tennis.web.app/.git/` 取得。
- 👉 需人工確認，並考慮改為「只部署必要檔案的乾淨資料夾」（見 C 方案）。本次僅記錄，不修改。

**A-3：`Deta/index.html`（線上唯一主程式）**
- 8,371 行單檔，UI / 邏輯 / DB 全在一起。任何一行語法錯誤 → 全站白畫面。
- 沒有測試、沒有 build step（直接部署原始檔），改了沒人擋。
- 高危區段：`submitBooking`（併場/衝突邏輯）、`submitFinanceRecord`（會籍回寫）、`_canEnter`/`isAdminLike`（權限）、`firebaseConfig`（DB 連線）、`LIFF_ID`（登入）。

**A-4：`firebase.json` / `.firebaserc`**
- 改 `public`、`ignore`、`rewrites`、`projectId` 任一個，都可能讓整站連錯資料庫或部署錯檔案。

**A-5：欄位命名一致性**
- `members` 同義欄位（`membershipExpiry`/`expireDate`、`active`/`approved`）。改動顯示邏輯時容易只改一半造成資料不一致。

**容易「改錯地方」的陷阱**
- `src/`、`_legacy/`、`README.md` 看起來像正式程式，但**改它們不會影響線上**。新人很容易在 React 版改半天卻沒效果。

---

## 六、B. 未來 LINE Agent 最適合接入的位置

> 目標：把現有 Firestore 資料 + 流程，接上一個 LINE 對話式 Agent。建議**走後端、不要動前端 monolith**。

**最佳接入點：新增一支 Cloud Function（沿用 `functions/` codebase）當 LINE Webhook**
理由：資料模型清楚（5 個 collection）、現有後端是空殼可直接擴充、不碰高危的 index.html。

建議的接入能力（由易到難）：
1. **查詢類（唯讀，最安全先做）**
   - 「我下週有哪些預約」→ 讀 `bookings` where players contains uid。
   - 「我的會費到期了嗎」→ 讀 `financialRecords` / `members` 會籍狀態。
   - 「今天/本週球場排程」→ 讀 `bookings`。
   - 接入點：Webhook 收訊息 → 用 LINE userId 對 `members/{uid}` → 查對應 collection → 回覆。
2. **通知類（取代目前只寫 Firestore 不發 LINE 的缺口）**
   - 預約被取消 → 主動 LINE 推播（接 `_sendBookingNotifications` 寫入 `notifications` 之後，用 Firestore trigger 發 LINE push）。
   - 會費即將到期提醒（搭配排程 Function）。
   - 接入點：`notifications` 的 `onCreate` trigger，或排程掃 `_calcMemberFeeStatus`。
3. **操作類（需謹慎，要先有 Firestore Rules + 寫入驗證）**
   - 對話式預約 / 取消。建議延後到後端權限補齊後再做。

**關鍵前置：** 接 Agent 前務必先處理 A-1（Firestore Rules）。否則 Agent 一旦能寫入，等於把無防護的資料庫再開一個入口。

**身份對應現成可用：** `members` 文件 ID 就是 LINE userId，Webhook 拿到的 `source.userId` 可直接查，不需額外對應表——這對 LINE Agent 非常友善。

---

## 六、C. 建議的專案資料夾重整方案（暫不執行，待確認）

> 原則：保留歷史、縮小「線上實際內容」、降低誤改與誤部署。**全部等你確認後再動。**

**第一階段：止血（風險優先，不改功能）**
- 確認並修正部署範圍：避免 `.git/`、`Deta_Phase3_Preview.html`、舊文件被推上公開站（最乾淨做法是改用獨立的部署輸出資料夾，或補強 `ignore`）。
- 把 Firestore Rules 寫成 `firestore.rules` 納入版控與 `firebase.json`。

**第二階段：歸檔歷史（不刪，只搬）**
```
Deta/
├─ index.html  firebase.json  .firebaserc  manifest.json  public/   ← 線上必要
├─ docs/        ← 本次四份文件 + 舊 Deta_*.md 移此
└─ archive/     ← src/、_legacy/、lineauth/、Deta_Phase3_Preview.html 移此
                  （加 README 說明「歷史，非線上」）
```
- `functions/` 若要做 LINE Agent 則保留並啟用；否則一併歸檔。

**第三階段（較大決策，另議）**
- 決定主線：(a) 維持單檔 index.html、(b) 復活 src/ React 版。**二擇一，停止三套並存。**
- 拆模組、加最基本的部署前檢查（語法 lint）。

**重整時的鐵律**
- 任何搬移都先確認 `firebase.json` 的 `public` 與 `ignore` 會不會被影響。
- 搬完先在本機 / preview channel 驗證再正式部署。
- 一次只動一層，逐步驗證，別大改。

---

## 完成

四份文件（PROJECT_MAP / DATA_MODEL / PERMISSION_RULES / CURRENT_STATUS）皆已建立於 `Deta/`。
未修改任何程式、UI、資料庫、規則，未 commit、未 deploy。**等待你確認。**
