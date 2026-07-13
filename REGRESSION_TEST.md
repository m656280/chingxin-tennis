# REGRESSION_TEST.md — 清心網球系統正式部署前固定驗收清單

> 建立日期：2026-07-13
> 適用範圍：`Deta/index.html`（線上唯一主程式）、`firestore.rules`、`functions/`、`lineauth/`
> 專案：`chingxin-tennis` ｜ 正式網址：https://chingxin-tennis.web.app

---

## 0. 這份文件是什麼

清心系統**每一次修改任何功能（無論大小）**，都必須依下列流程執行，這份清單是「部署前的最後一道關」：

1. 完成程式修改。
2. 自行測試**所有受影響**的功能。
3. 執行本文件的**完整 Regression Test**（下方 19 項）。
4. **全部 PASS 後**才能 `commit` → `push` → `deploy`。
5. **任何一項 FAIL → 不得部署**，先找 root cause 修正，修正後從第 2 步重跑。

> 核心精神：寧可多測十分鐘，也不要把壞的東西推上線讓真實會員踩到。

---

## 1. 鐵則（不可妥協）

- **R1｜不得只用 mock data。** mock 只能當「邏輯快速自我檢查」，不能當驗收依據。
- **R2｜至少一次正式資料驗證。** 每次驗收，受影響功能**至少要用線上正式 Firestore 資料實跑一次**（見 §3 方法）。回報時要明確標示哪一項是用正式資料驗的。
- **R3｜改 Firestore Rules 必查前端 enum／type 一致性。** 只要動到 `firestore.rules`，就必須逐項比對前端送出的 `type` / `status` / `role` 值與 rules 白名單完全一致（見 §4）。這條是為了防止再次發生 `day_pass` 白名單事件（rules 寫 `dayPass`、前端送 `day_pass` → 臨打 permission-denied）。
- **R4｜Rules 變更需 MK 確認後才可 commit／deploy。** rules 一律本機手動部署（`deploy_rules_v1_X.command`），不走 CI。
- **R5｜正式資料測試禁止留下垃圾。** 若用「即建即刪」驗證寫入，務必確認資料庫零殘留（查一次 `financialRecords` 沒有 QA 測試筆數）。
- **R6｜回報格式固定**（見 §6）：測試項目、PASS/FAIL、Commit ID、Push 結果、Deploy 結果。

---

## 2. 完整 Regression 清單（19 項）

> 「受影響才必測」的項目仍建議全跑；但**財務類（annual/monthly/day_pass/donate/expense）與 Rules 相關的修改，19 項一律全跑**，因為它們共用同一條寫入路徑與同一份 rules 白名單。
> 勾選欄：☐ 未測　✅ PASS　❌ FAIL

| # | 項目 | 怎麼驗（實際操作 / 真實資料） | 通過標準 |
|---|---|---|---|
| 1 | ☐ LINE 登入 | LINE App 內開 LIFF（`2010122854-usyGQhHI`），完成 `liff.init`→`getProfile`；管理員登入後 `ensureFirebaseAuth()` 應成功（Console 無 `[AUTH] 管理員 Firebase Auth 啟動登入失敗`） | 能進入主畫面、角色正確、無 auth 失敗橫幅 |
| 2 | ☐ 會員新增（LINE） | 用未註冊 LINE 帳號首次登入 → `members/{lineUserId}` 建立、`status:'pending'`、`role:'member'` | 新文件建立、預設狀態正確、進入「待審核」畫面 |
| 3 | ☐ 手動新增會員 | 會員管理頁 →「新增手動會員」→ 填正式姓名等 → `createManualMember` callable 寫入 | 建立成功、`memberSource:'manual'`、`status:'approved'`；非 owner/admin 呼叫應被拒 |
| 4 | ☐ 會員審核 | 對 pending 會員按核准／退回／封鎖／恢復 | status 正確轉換、`approvedAt/approvedBy` 寫入、被封鎖/刪除者無法進入 |
| 5 | ☐ 年費記帳 | 財務頁新增：類型=年費、選會員、金額、會籍年度 → 儲存 | 建立成功、回寫 `membershipExpiry`；同會員同年度重複應擋下 |
| 6 | ☐ 月費記帳 | 類型=月費、選會員、期數（含多月）→ 儲存 | 單筆建立、`periodMonths`/`billingYear`/`billingMonth` 正確、重複帳期擋下 |
| 7 | ☐ 臨打記帳（**回歸重點**） | 類型=臨打、**不選會員**、備註填臨打者姓名、金額 → 儲存 | **能成功建立**（type=`day_pass`）；未選會員 + 備註姓名為合法情境 |
| 8 | ☐ 捐款 | 類型=抖內（donate）、金額 → 儲存 | 建立成功、列入捐款統計 |
| 9 | ☐ 支出 | 類型=支出（expense）、金額、備註 → 儲存 | 建立成功、列入支出、結餘正確扣減 |
| 10 | ☐ 財務統計 | 財務總覽頁：總收入/支出/結餘、各類型筆數與金額 | 數字與明細加總一致（年費+月費+臨打+捐款+其他−支出=結餘） |
| 11 | ☐ 財務 PDF | 財務頁 → 匯出 PDF（選範圍）→ `_buildFinancePDFHtml` | A4、總覽+明細+每月結餘正確、分享 PDF 可產生檔案 |
| 12 | ☐ 財務 CSV | 財務頁 → 匯出 CSV → `_runExportCSV` | UTF-8 BOM、Excel 可開、各區塊數字與畫面一致 |
| 13 | ☐ 會員名冊 PDF | 會員管理頁 → 匯出名冊 PDF → 選類別(年費/月費)+年度 | 兩類不混冊、欄位=編號/姓名/入會日期/備註、依繳費日期舊→新排序、標題/檔名含年度+類別 |
| 14 | ☐ 會員名冊 CSV | 同上但匯出 Excel/CSV | 篩選/排序/欄位與 PDF **完全一致**、檔名 `清心網球協會_YYYY年度_年費會員名冊.csv` |
| 15 | ☐ 預約功能 | 建立預約（一般/教學/公益團課/活動）；紅土場、團課、活動限 owner/admin | 衝突/併場規則正確、`bookings` 寫入、跨場時間衝突擋下 |
| 16 | ☐ LINE Agent | 觸發系統自動公告/通知（如團課建立→公告）路徑 | `announcements`/`notifications` 正常寫入與顯示 |
| 17 | ☐ Email 功能 | 若有寄信路徑（如通知/驗證），實際觸發一次 | 信件送達、內容正確；無此路徑則標記 N/A 並說明 |
| 18 | ☐ Firestore Rules 驗證 | `firestore.rules` 編譯 + 正式站以真實 payload 實測 create/update（見 §4） | 合法 payload 成功、非法 payload 被拒；**前端 enum 與白名單一致** |
| 19 | ☐ Hosting 部署驗證 | deploy 後線上抓 `/index.html`，確認含本次修改標記（見 §5） | 線上程式 = 最新 commit、非舊版殘留 |

---

## 3. 正式資料驗證方法（R2 用）

**不要只信 mock。** 用下列方式之一，用線上正式 Firestore 實跑：

- **方式 A（推薦，讀 + 邏輯）**：在已登入的正式站頁面 Console／自動化，用線上已初始化的 `db` 拉真實資料，再跑目標函式：
  ```js
  const fin = await db.collection('financialRecords').get({source:'server'});
  financeRecords = fin.docs.map(d => Object.assign({id:d.id}, d.data()));
  const ms = await db.collection('members').get({source:'server'});
  ms.docs.forEach(d => usersCache[d.id] = Object.assign({userId:d.id}, d.data()));
  // → 呼叫 _prepMemberRosterData(2026,'annual') 等，比對真實筆數/排序
  ```
- **方式 B（寫入驗證，即建即刪）**：用真實 payload `db.collection('financialRecords').add(rec)` → 成功後**立即 `ref.delete()`**，並於結尾查 `financialRecords` 無 QA 殘留（遵守 R5）。
- **UI 全鏈路**：能走真實按鈕流程就走（開匯出 sheet → 選項 → 匯出 / 財務表單 → 儲存），比純函式呼叫更接近使用者。

> 正式資料驗證要「至少一項」，高風險改動（財務、rules、名冊）建議受影響項目全部用正式資料驗。

---

## 4. Rules ↔ 前端 enum 一致性檢查（R3，強制）

只要動 `firestore.rules`，**逐格比對**下表，前端有的值 rules 一定要收：

| 類別 | 前端實際送出值（來源） | rules 白名單（`firestore.rules`） | 一致？ |
|---|---|---|---|
| finance `type` | `annual` / `monthly` / **`day_pass`** / `donate` / `expense`（表單 option，index.html ~1913）；匯出邏輯另涉 `coaching_fee`/`coach_fee`/`coaching` | `isValidFinanceType`：annual, monthly, **day_pass**(+dayPass), coaching_fee/coach_fee/coaching(+coach), donate, other, expense | ☐ |
| finance `status` | `active` / `void` / `refund`（退款修正） | `isValidFinanceStatus`：active, void, refund | ☐ |
| booking `status` | `active` / `cancelled` / `void` / `auto_moved` | `isValidBookingStatus`：active, cancelled, void, auto_moved | ☐ |
| member `role`（前端可建立） | `member` / `coach` | `isSafeMemberRole`：member, coach | ☐ |

**檢查步驟：**
1. `grep -n 'value="' index.html` 找出財務/預約表單所有 option 真值。
2. 對照 `firestore.rules` 的 `isValid*` 函式白名單。
3. **前端任一值不在 rules 白名單 → 該寫入會 permission-denied → 視為 FAIL**，先補白名單再繼續。
4. `firebase deploy --only firestore:rules` 前，本機 `firebase deploy ... ` 會先做 rules 編譯檢查；編譯過 ≠ 語意對，仍要用正式站 payload 實測（項目 18）。

> ⚠️ 歷史事件：2026-07-12「臨打無法儲存」= rules 寫 `dayPass`、前端送 `day_pass`。這格不一致就是 root cause。這張表就是為了不再發生。

---

## 5. 部署與線上驗證

**部署管道（依 [[chingxin-deploy-method]]）：**
- **Hosting**：push 到 `stable-lucky-7` 會觸發 CI 自動部署 hosting；或本機雙擊 `deploy_roster_v1.command`（含版本標記防呆 + 線上驗證）。
- **Rules**：**只**本機手動 `deploy_rules_v1_X.command`（不走 CI，需 MK 確認）。
- **Functions**（functions/、lineauth/）：本機對應 `fix_*_deploy.command`。
- **Push**：`push_to_github.command`（GitHub 認證已用 gh CLI 建好，token 存 osxkeychain）。

**部署後線上驗證（項目 19，強制）：**
```js
// 正式站 Console，比對線上程式含本次修改標記
const src = await fetch('/index.html?cb='+Date.now()).then(r=>r.text());
src.includes('<本次改動的獨特字串/函式名>')   // 應為 true
```
或用 sha256 比對本地 HEAD 的 index.html 與線上 `/index.html`。**線上 ≠ 最新 → 部署未生效 → FAIL**（多半是舊 session 快取或 Dropbox 未同步，重新部署/強制重載）。

---

## 6. 回報格式（R6，固定）

每次完成一律以此格式回報：

```
【測試結果】
 1. LINE 登入 ............ PASS / FAIL / N/A（說明）
 2. 會員新增（LINE） ..... PASS / FAIL / N/A
 ...（列完 19 項）...
 18. Firestore Rules ..... PASS（含 enum 一致性表已比對）
 19. Hosting 部署驗證 .... PASS（線上 = <commit>）

【正式資料驗證】哪些項目用正式資料實跑（至少一項）：____
【Root cause】若有 FAIL：現象 → 根因 → 修法

【Commit ID】<hash>（<一句話說明>）
【Push 結果】<local..remote>，exit 0，origin/stable-lucky-7 = <hash>
【Deploy 結果】Hosting: 成功/未動；Rules: 成功/未動；Functions: 成功/未動
```

---

## 7. 一頁速記（貼在腦子裡）

> 改完 → 測受影響 → 跑 19 項 → **改 rules 必比 §4 enum 表** → 至少一項用正式資料 → 全 PASS → commit → push → deploy → 線上驗證 = 最新 → 按 §6 回報。**任一 FAIL 不部署，先修 root cause。**
