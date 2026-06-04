# DATA_MODEL.md — 清心網球系統資料模型

> 整理日期：2026-06-04
> 來源：直接從 `Deta/index.html` 的實際讀寫程式碼推導，非舊設計文件。
> 資料庫：Firestore（專案 `chingxin-tennis`），共 5 個 collection。

---

## Collection 總覽與關係

```
members/{lineUserId}          ← 帳號 + 角色 + 會籍狀態（文件 ID = LINE userId）
   │
   ├─< financialRecords.memberId        繳費/支出紀錄指回會員
   │      （年費/月費紀錄會「回寫」membershipExpiry 到 members）
   │
   ├─< bookings.createdBy / players[] / coachId / students[]   預約的人指回會員
   │
   ├─  members.coachStudents{}          教練的學生清單（內嵌 map，不是獨立 collection）
   │
   └─< notifications.uid                個人通知指回會員

announcements/{autoId}        公告（含系統自動產生的團課公告）
```

> ⚠️ 沒有外鍵約束（Firestore 本來就沒有）。關聯全靠欄位裡存的 `uid` 字串。會員被永久刪除時，歷史的 `bookings` / `financialRecords` 仍保留其 uid，但 `members` 文件已不存在 → 顯示時靠 `memberNameSnapshot` 之類的「快照欄位」救援。

---

## 1. `members/{lineUserId}`

文件 ID = LINE userId（由 LIFF 取得）。**唯一的真實「使用者」來源**。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `uid` | string | 同文件 ID（冗餘存一份） |
| `displayName` | string | LINE 暱稱（每次登入會覆寫更新） |
| `realName` | string | 正式姓名（管理員手動填，財務/點名用） |
| `photoURL` | string | LINE 頭像 URL（每次登入更新） |
| `role` | string | **`owner` / `admin` / `coach` / `member`**（見 PERMISSION_RULES.md） |
| `status` | string | 會籍狀態（見下方狀態機） |
| `approved` | boolean | 舊版核准旗標，與 status 並存（相容用） |
| `ntrp` | number/string | 網球分級 NTRP |
| `preferredPosition` | string | 慣用位置 |
| `membershipType` | string | `annual`（年費）/ `monthly`（月費）/ `''` |
| `membershipExpiry` | string | 會籍到期日 `YYYY/MM/DD`（由財務紀錄回寫） |
| `expireDate` | string | 同上，舊欄位名（兩個都會被寫，顯示時互為 fallback） |
| `coachStudents` | map | **僅教練有**。`{ studentUid: {attendanceDate, paymentDate, coachNote} }` |
| `createdAt` | timestamp | 首次登入建立時間 |
| `lastLoginAt` | timestamp | 最後登入（每次登入更新） |
| `approvedAt` / `approvedBy` | timestamp / uid | 核准時間與核准者 |
| `updatedAt` | timestamp | 最後異動 |
| `deletedAt`/`blockedAt`/`unblockedAt`/`restoredAt`/`reappliedAt` | timestamp | 各種狀態轉換的時間戳 |

### status 狀態機

新會員首次登入由前端 `_upsertAndRoute()` 建立，預設 `status:'pending'`、`role:'member'`。

```
            (首次登入)
                │
                ▼
            pending ──approveMember──▶ approved/active ──┐
                │                          ▲             │
          rejectMember                     │         removeMember
                │               reApprove/restore         │
                ▼                          │               ▼
            rejected ───reOpen──▶ pending  │            deleted ──permanentDelete──▶ (文件刪除, owner only)
                                           │               │
                                  unblock──┘            restore
                                           │               │
            blocked ◀──blockMember─────────┴───────────────┘
            resigned（離會，財務端 _finMarkResigned 設定）
```

可進入系統的判定在 `_canEnter(d)`：
- `status` 是 `deleted` 或 `blocked` → **永遠擋住**（即使是 admin）。
- `role` 是 `owner` / `admin` → **永遠放行**（不看 status）。
- `status` 是 `active` 或 `approved`，或 `approved===true` → 放行。
- 其他（pending / rejected / resigned / expired / inactive…）→ 擋在登入後的對應畫面。

> 🟠 注意：`status` 的值在程式各處不完全一致——`active`、`approved` 兩者都代表「已核准」；`deleted`、`removed`、`expired`、`inactive` 都會被導到「可重新申請」畫面。這種「多個值代表同一件事」是技術債，見 CURRENT_STATUS.md。

---

## 2. `bookings/{autoId}`

球場預約。由 `submitBooking()` 建立。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `date` | string | `YYYY-MM-DD` |
| `startTime` / `endTime` | string | `HH:MM` |
| `court` | string | `hard_a` / `hard_b` / `clay_a` / `clay_b` |
| `mode` | string | `general`(一般) / `pickleball`(匹克球) / `teaching`(教學) / `groupClass`(團課) / `event_lock`(活動鎖場) |
| `status` | string | `active`（有效）/ `confirmed`（舊值，同視為有效）/ `cancelled` / `void` |
| `createdBy` | uid | 建立者 |
| `createdByName` | string | 建立者姓名快照 |
| `primaryName` | string | 預約主人顯示名（相容欄位） |
| `players` | array<uid> | 參與會員。一般場固定 4 人上限；其他模式視 capacity |
| `guests` | array<string> | 訪客「姓名字串」（非 uid） |
| `capacity` | number | 上限人數（一般場固定 4） |
| `participantCount` | number | 目前人數（加入時 `increment(1)`） |
| `coachId` / `coachName` | uid / string | 教學、團課模式的教練 |
| `students` | array<uid> | 教學模式的學生清單 |
| `title` | string | 標題；`event_lock` 模式存「活動性質」 |
| `note` | string | 備註（非一般模式才存） |
| `createdAt` / `updatedAt` | timestamp | |

**衝突／併場規則（寫在 `submitBooking`）：**
- `teaching` / `groupClass` / `event_lock` 為**獨占模式**，不可與任何預約共用時段。
- `general` / `pickleball` 同模式可「加入」既有預約（`arrayUnion` 到 players），不同模式不可混用。
- 另有跨場時間衝突檢查 `hasParticipantTimeConflict()`：同一人不可在重疊時段出現在兩個場地。
- 紅土場（clay_a/clay_b）、團課、活動鎖場 → **僅 owner/admin 可建立**。

---

## 3. `financialRecords/{autoId}`（= payments / finance schema）

財務紀錄。由 `submitFinanceRecord()` 建立，`isAdminLike()`（owner/admin）才可寫。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `type` | string | `annual`(年費) / `monthly`(月費) / `donate`(抖內) / `expense`(支出) |
| `memberId` | uid | 對應會員（支出可空） |
| `memberDisplayName` | string | 會員暱稱快照 |
| `memberRealName` | string | 會員正式姓名快照 |
| `memberNameSnapshot` | string | `realName \|\| displayName`，**會員被刪也救得回名字** |
| `year` | number | 帳務年度（`_finYear`，財務報表分年用） |
| `date` | string | 收款/支出日期 `YYYY-MM-DD` |
| `amount` | number | 金額（正整數） |
| `note` | string | 備註 |
| `membershipType` | string | `annual` / `monthly` / `''`（只有年費月費才有） |
| `membershipYear` | number | 年費的會籍年度（決定到期年） |
| `membershipExpiry` | string | 算出的到期日 `YYYY/MM/DD` |
| `status` | string | `active`（有效）/ `void`（作廢）/ `refund`（退費）/ `deleted` / `archived` |
| `createdByUid` / `createdByName` | uid / string | 建立者 |
| `updatedByUid` / `updatedByName` | uid / string | 最後修改者 |
| `createdAt` / `updatedAt` | timestamp | |

**重要的跨表副作用（資料一致性關鍵）：**
寫入年費/月費紀錄時，會**同步回寫** `members/{memberId}`：
```
members.membershipType   = annual|monthly
members.membershipExpiry = 算出的到期日
members.expireDate       = 同上
```
到期日由 `_calcMembershipExpiry()` 算：年費 → `該年度/12/31`；月費 → 收款日 +1 個月。

**會費狀態的唯一真實來源是 financialRecords，不是 members。**
`_calcMemberFeeStatus()` 只認 `status==='active'` 的年/月費紀錄，取到期日最晚那筆判斷「已繳清 / 即將到期 / 已到期 / 尚未繳費」。`members` 上的會籍欄位只是顯示快取。

---

## 4. `announcements/{autoId}`

| 欄位 | 型別 | 說明 |
|---|---|---|
| `title` | string | 標題 |
| `content` | string | 內容 |
| `updatedAt` | timestamp | 排序依據（`orderBy('updatedAt','desc')`） |
| `updatedBy` | string | 最後編輯者顯示名 |

> 團課（groupClass）預約成立時，`_createGroupClassAnnouncement()` 會自動寫一筆公告（僅在該預約日顯示）。系統公告（如待審成員提醒）由 `_generateSystemAnnouncements()` 動態組出，不一定落地成文件。

---

## 5. `notifications/{autoId}`

個人通知（目前主要用於「預約被管理員取消/作廢」）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `uid` | uid | 收件人 |
| `type` | string | `booking_cancelled` / `booking_void` |
| `action` | string | `cancel` / `void` |
| `bookingId` | string | 關聯預約 |
| `date`/`startTime`/`endTime`/`court`/`courtLabel` | | 預約資訊快照 |
| `cancelledByName` / `cancelledByUid` | | 操作者 |
| `cancelReason` | string | 原因 |
| `message` | string | 完整訊息（相容用） |
| `read` | boolean | 已讀 |
| `createdAt` | timestamp | |
| `expiresAt` | Date | 建立 +30 天（前端用，非 TTL policy） |

---

## 子結構：`members.coachStudents`（教練↔學生）

不是獨立 collection，是**內嵌在教練 member 文件裡的 map**：

```
members/{coachUid}.coachStudents = {
  "{studentUid}": { attendanceDate: "YYYY-MM-DD", paymentDate: "YYYY-MM-DD", coachNote: "..." },
  ...
}
```

由 `assignStudentToCoach` / `saveCoachStudentRecord` / `removeStudentFromCoach` 維護。教練只能編輯自己的；admin/owner 可編輯任何教練的。

---

## 與舊文件的差異提醒

`Deta_Data_Model.md`（5/19）描述的是 React 版規劃，部分 collection 名稱（如 `users`、`sessions`）與現況不同：
- 線上用 **`members`**，不是 `users`。
- 線上**沒有** `sessions` collection（那是未使用的 `lineauth/` 後端才有的設計）。

以本文件為準。
