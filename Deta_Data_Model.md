# Deta Data Model
## 清心球場營運管理系統 — 資料模型規範

> 版本：v1.0
> 文件性質：資料模型規範（Data Model Specification）
> 對應文件：`Deta_System_Architecture.md` v1.0
> 適用範圍：Firestore 結構設計、關聯、索引、權限對應

---

## 0. 文件定位與設計原則

本文件是 Deta 專案的「資料層單一事實來源」。所有 Collection、欄位、關聯、索引、權限對應，皆以本文件為依據。

**設計原則**

1. **與 Architecture 文件嚴格對齊**：所有欄位命名、角色、模式、場地代號，必須與 `Deta_System_Architecture.md` 一致。
2. **平坦優於巢狀**：Firestore 是文件資料庫，盡量避免深層巢狀，改用 collection 之間的引用。
3. **欄位命名**：統一使用 `camelCase`。
4. **時間欄位**：所有時間統一使用 Firestore `timestamp` 型別，UI 層再轉換為當地時間顯示。
5. **歷史不可變**：booking、payment、expense 已生效紀錄不做硬刪除，只做狀態更新或軟刪除。
6. **權限交給 Security Rules**：本文件只標示「誰應該能讀寫」，實際規則於 `Deta_Security_Rules.md`（下一階段）撰寫。

---

## 1. Firestore Collections 總覽

| Collection | 用途 | Document ID 策略 |
|---|---|---|
| `users` | 會員、教練、管理員、擁有者主檔 | LINE userId |
| `bookings` | 場地預約紀錄 | 自動生成 |
| `events` | 行事曆事件（非預約類） | 自動生成 |
| `payments` | 收費紀錄（月費 / 年費 / 捐款 / 活動費） | 自動生成 |
| `expenses` | 支出紀錄 | 自動生成 |
| `annualReports` | 年度報表彙總結果 | `{year}`（例：`2026`） |
| `settings` | 系統設定（寒暑假日期等） | 固定 key |
| `auditLogs` | 重要操作紀錄（管理層操作） | 自動生成 |

頂層共 **8 個 Collection**，無深層巢狀。

---

## 2. 各 Collection 欄位定義

### 2.1 `users`

會員主檔，所有角色共用同一個 collection，以 `role` 區分。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `userId` | string | ✓ | 與 LINE userId 對應，作為 Document ID |
| `lineAvatar` | string (url) | ✓ | LINE 頭像 URL，登入時帶入 |
| `displayName` | string | ✓ | 顯示名稱，可由會員自訂 |
| `role` | string (enum) | ✓ | `owner` / `admin` / `annual_member` / `monthly_member` / `coach` / `pending` |
| `ntrp` | number | ✗ | NTRP 等級，由會員自設（例：3.5） |
| `preferredPosition` | string | ✗ | 擅長位置，由會員自設（例：底線、網前） |
| `coachId` | string (ref → users) | ✗ | 教練的 userId，可空白 |
| `clayAccess` | boolean | ✓ | 預設 `false`，管理員可為月費會員或教練單獨開啟 |
| `annualExpiresAt` | timestamp | ✗ | 年費會員到期日（統一 12/31） |
| `monthlyExpiresAt` | timestamp | ✗ | 月費會員到期日（滾動制） |
| `membershipStatus` | string (enum) | ✓ | `active` / `expired` / `pending`，由每日 scheduled job 自動更新 |
| `createdAt` | timestamp | ✓ | 註冊時間 |
| `updatedAt` | timestamp | ✓ | 最後更新時間 |
| `lastLoginAt` | timestamp | ✗ | 最後登入時間 |

**規則**

- `role` 只能由 `owner` / `admin` 修改
- `ntrp`、`preferredPosition`、`coachId`、`displayName` 可由會員本人修改
- `clayAccess`、`annualExpiresAt`、`monthlyExpiresAt` 只能由 `owner` / `admin` 修改
- `membershipStatus` 不可手動修改，由系統每日自動計算

---

### 2.2 `bookings`

場地預約紀錄。1 slot = 30 分鐘。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `bookingId` | string | ✓ | 自動生成 Document ID |
| `date` | string (YYYY-MM-DD) | ✓ | 用於 query，固定為當日日期字串 |
| `startTime` | string (HH:mm) | ✓ | 開始時間，30 分鐘對齊 |
| `endTime` | string (HH:mm) | ✓ | 結束時間，30 分鐘對齊 |
| `startAt` | timestamp | ✓ | 完整 timestamp，用於排序與比較 |
| `endAt` | timestamp | ✓ | 完整 timestamp |
| `court` | string (enum) | ✓ | `hard_a` / `hard_b` / `clay_a` / `clay_b` |
| `surface` | string (enum) | ✓ | `hard` / `clay`，由 `court` 推導，仍冗餘儲存以利 query |
| `mode` | string (enum) | ✓ | `normal` / `coaching` / `group_class` / `pickleball` / `event_lock` |
| `maxParticipants` | number | ✓ | 由 mode 決定上限（normal=4, pickleball=8, coaching/group_class=999, event_lock=999） |
| `bookedBy` | string (ref → users) | ✓ | 預約建立者 userId |
| `actualUser` | string (ref → users) | ✓ | 實際使用者 userId（代掛時與 `bookedBy` 不同） |
| `participants` | array&lt;string&gt; (ref → users) | ✗ | 同場參與者 userId 清單，可空 |
| `note` | string | ✗ | 備註 |
| `status` | string (enum) | ✓ | `active` / `cancelled` |
| `isProxyBooking` | boolean | ✓ | `bookedBy !== actualUser` 時為 `true` |
| `createdAt` | timestamp | ✓ | 建立時間 |
| `updatedAt` | timestamp | ✓ | 最後更新時間 |
| `lockedAfterStart` | boolean | ✓ | 時段開始後鎖定，由系統自動標記 |

**規則**

- 同一 `date` + `court` + 時段範圍只能有一筆 `status = active` 的紀錄
- 時段開始（`now >= startAt`）後不可修改、不可刪除，只能保留歷史
- `event_lock` 模式只能由 `owner` / `admin` 建立
- `month_member` 預設只能建立 `surface = hard` 的 booking，除非 `users.clayAccess = true`

---

### 2.3 `events`

行事曆事件。與 booking 並存，用於記錄非預約類安排。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `eventId` | string | ✓ | 自動生成 Document ID |
| `title` | string | ✓ | 事件名稱，自由輸入 |
| `date` | string (YYYY-MM-DD) | ✓ | 用於 query |
| `startTime` | string (HH:mm) | ✓ | |
| `endTime` | string (HH:mm) | ✓ | |
| `startAt` | timestamp | ✓ | |
| `endAt` | timestamp | ✓ | |
| `court` | string (enum) | ✗ | 同 `bookings.court`，可空（純行政事件） |
| `surface` | string (enum) | ✗ | `hard` / `clay`，可空 |
| `note` | string | ✗ | 備註 |
| `createdBy` | string (ref → users) | ✓ | 建立者 userId |
| `isLocked` | boolean | ✓ | 是否鎖場，預設 `false` |
| `colorTag` | string (enum) | ✗ | UI 視覺標記：`clay_red` / `blue` / `yellow_dot` / `green_dot`，由系統依規則推導 |
| `createdAt` | timestamp | ✓ | |
| `updatedAt` | timestamp | ✓ | |

**規則**

- 不需要 `eventType`，事件名稱由使用者自由輸入
- `colorTag` 為視覺輔助，不影響資料分類
- 若 `isLocked = true`，該時段的場地視同被佔用，不可再建立 booking

---

### 2.4 `payments`

收費紀錄，涵蓋月費、年費、捐款、活動費。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `paymentId` | string | ✓ | 自動生成 Document ID |
| `type` | string (enum) | ✓ | `monthly` / `annual` / `donation` / `event` |
| `payerId` | string (ref → users) | ✓ | 付款人 userId |
| `payerName` | string | ✓ | 冗餘儲存，避免 user 改名後歷史紀錄失真 |
| `amount` | number | ✓ | 金額（新台幣，整數） |
| `date` | string (YYYY-MM-DD) | ✓ | 付款日期 |
| `note` | string | ✗ | 備註 |
| `recordedBy` | string (ref → users) | ✓ | 登記人 userId |
| `recordedByName` | string | ✓ | 登記人名稱（冗餘） |
| `recordedByAvatar` | string (url) | ✓ | 登記人 LINE 頭像（冗餘） |
| `recordedAt` | timestamp | ✓ | 登記時間 |
| `relatedEventId` | string (ref → events) | ✗ | 若 type = `event`，可關聯到具體活動 |
| `affectsMembershipUntil` | timestamp | ✗ | 若 type = `monthly` 或 `annual`，記錄這筆繳費延展到的到期日 |

**規則**

- `type = monthly` 時，登記後系統自動更新該 `payerId` 的 `users.monthlyExpiresAt`
- `type = annual` 時，登記後系統自動更新該 `payerId` 的 `users.annualExpiresAt`
- 冗餘儲存付款人 / 登記人姓名與頭像，避免日後改名造成報表錯亂
- 已建立的紀錄可由 `owner` / `admin` 修改或軟刪除（不做硬刪除）

---

### 2.5 `expenses`

支出紀錄，與 `payments` 分開。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `expenseId` | string | ✓ | 自動生成 Document ID |
| `name` | string | ✓ | 支出名稱 |
| `amount` | number | ✓ | 金額（新台幣，整數） |
| `date` | string (YYYY-MM-DD) | ✓ | 支出日期 |
| `category` | string | ✓ | 分類（例：場地維護、設備、清潔、雜支） |
| `paidBy` | string | ✓ | 付款人姓名（可能為非會員，故為字串而非 ref） |
| `recordedBy` | string (ref → users) | ✓ | 登記人 userId |
| `recordedByName` | string | ✓ | 冗餘 |
| `recordedByAvatar` | string (url) | ✓ | 冗餘 |
| `recordedAt` | timestamp | ✓ | |
| `note` | string | ✗ | |

**規則**

- 不上傳收據照片，故不需 `attachmentUrl` 欄位
- 已建立紀錄可由 `owner` / `admin` 修改或軟刪除

---

### 2.6 `annualReports`

年度報表彙總結果。**每年一份文件**，由 scheduled job 每日重算當年度。

Document ID：`{year}`，例如 `2026`。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `year` | number | ✓ | 報表年度 |
| `periodStart` | timestamp | ✓ | 固定為該年 1/1 00:00 |
| `periodEnd` | timestamp | ✓ | 固定為該年 12/31 23:59 |
| `income` | map | ✓ | 收入彙總（見下方結構） |
| `expense` | map | ✓ | 支出彙總 |
| `donation` | map | ✓ | 捐款彙總 |
| `events` | map | ✓ | 活動彙總 |
| `courtUsage` | map | ✓ | 場地使用統計 |
| `membership` | map | ✓ | 會員數統計 |
| `coachStats` | map | ✓ | 教練相關統計（僅管理層可讀） |
| `lastComputedAt` | timestamp | ✓ | 最後彙總時間 |

**子結構**

```
income: {
  total: number,
  byType: {
    monthly: number,
    annual: number,
    event: number
  },
  byMonth: [number * 12]   // 1 月 ~ 12 月
}

expense: {
  total: number,
  byCategory: { [category: string]: number },
  byMonth: [number * 12]
}

donation: {
  total: number,
  count: number,
  byMonth: [number * 12]
}

events: {
  total: number,
  byMode: {
    normal: number,
    coaching: number,
    group_class: number,
    pickleball: number,
    event_lock: number
  }
}

courtUsage: {
  hard_a: { slots: number, hours: number },
  hard_b: { slots: number, hours: number },
  clay_a: { slots: number, hours: number },
  clay_b: { slots: number, hours: number }
}

membership: {
  annualMemberCount: number,
  monthlyMemberCount: number,
  coachCount: number,
  newAnnualThisYear: number,
  newMonthlyThisYear: number
}

coachStats: {
  byCoach: {
    [coachUserId: string]: {
      studentCount: number,
      sessionsConducted: number,
      studentPaymentTotal: number
    }
  }
}
```

詳細聚合邏輯見第 8 節。

---

### 2.7 `settings`

系統設定，少量固定文件。

| Document ID | 用途 |
|---|---|
| `schoolBreaks` | 仕隆國小寒暑假日期 |
| `bookingRules` | 開放時段規則（若日後可調整） |
| `branding` | UI 品牌設定（顏色 token、文案） |

**`settings/schoolBreaks` 結構**

| 欄位 | 型別 | 說明 |
|---|---|---|
| `breaks` | array&lt;map&gt; | 寒暑假時段陣列 |
| `breaks[].name` | string | 例：`2026 暑假` |
| `breaks[].startDate` | string (YYYY-MM-DD) | |
| `breaks[].endDate` | string (YYYY-MM-DD) | |
| `updatedAt` | timestamp | |
| `updatedBy` | string (ref → users) | |

---

### 2.8 `auditLogs`

重要操作紀錄。涵蓋會員角色變更、booking 刪除、付款紀錄修改等。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `logId` | string | ✓ | 自動生成 |
| `actorId` | string (ref → users) | ✓ | 操作者 userId |
| `actorName` | string | ✓ | 冗餘 |
| `action` | string (enum) | ✓ | 例：`update_role` / `delete_booking` / `update_payment` |
| `targetCollection` | string | ✓ | 例：`users` / `bookings` |
| `targetId` | string | ✓ | 目標文件 ID |
| `before` | map | ✗ | 變更前快照 |
| `after` | map | ✗ | 變更後快照 |
| `at` | timestamp | ✓ | |

只能由系統寫入，無人可改、無人可刪。

---

## 3. 關聯方式

Firestore 不做 join，所有「關聯」皆以 ID 引用為主，必要時冗餘儲存常用欄位（如姓名、頭像）以減少讀取次數。

```
users (userId)
  ├─ bookings.bookedBy        → users.userId
  ├─ bookings.actualUser      → users.userId
  ├─ bookings.participants[]  → users.userId
  ├─ events.createdBy         → users.userId
  ├─ payments.payerId         → users.userId
  ├─ payments.recordedBy      → users.userId
  ├─ expenses.recordedBy      → users.userId
  ├─ users.coachId            → users.userId  （自我引用，學生指向教練）
  └─ auditLogs.actorId        → users.userId

events (eventId)
  └─ payments.relatedEventId  → events.eventId
```

**冗餘欄位的原則**

| 場景 | 冗餘欄位 | 原因 |
|---|---|---|
| `payments` | `payerName`, `recordedByName`, `recordedByAvatar` | 報表顯示頻繁，且需保留歷史身份 |
| `expenses` | `recordedByName`, `recordedByAvatar` | 同上 |
| `bookings` | （不冗餘）| 預約場景顯示時即時 join，且使用者頭像變動會即時影響 |
| `auditLogs` | `actorName` | 即使該 user 被刪除，log 仍可閱讀 |

---

## 4. Index 建議

Firestore 自動建立單欄位 index。以下為建議的**複合 index**，依據實際 query 場景。

### 4.1 `bookings`

| Index | 用途 |
|---|---|
| `(date ASC, court ASC, startTime ASC)` | 日 / 週 / 月視圖查詢 |
| `(date ASC, status ASC, startTime ASC)` | 排除 cancelled 的時段查詢 |
| `(actualUser ASC, startAt DESC)` | 個人預約歷史 |
| `(bookedBy ASC, startAt DESC)` | 代掛人視角 |
| `(court ASC, startAt ASC)` | 場地使用統計 |
| `(mode ASC, startAt DESC)` | 報表按模式分類 |

### 4.2 `events`

| Index | 用途 |
|---|---|
| `(date ASC, startTime ASC)` | Calendar 視圖 |
| `(court ASC, date ASC)` | 場地佔用判斷 |
| `(createdBy ASC, startAt DESC)` | 個人事件 |

### 4.3 `payments`

| Index | 用途 |
|---|---|
| `(type ASC, date DESC)` | 報表按類型 |
| `(payerId ASC, date DESC)` | 個人繳費歷史 |
| `(date ASC, type ASC)` | 年度報表聚合 |
| `(recordedBy ASC, recordedAt DESC)` | 登記人視角 |

### 4.4 `expenses`

| Index | 用途 |
|---|---|
| `(date ASC, category ASC)` | 報表按分類 |
| `(category ASC, date DESC)` | 分類查詢 |

### 4.5 `users`

| Index | 用途 |
|---|---|
| `(role ASC, displayName ASC)` | 角色列表 |
| `(role ASC, monthlyExpiresAt ASC)` | 月費到期掃描 |
| `(coachId ASC, role ASC)` | 教練查詢自己學生 |
| `(membershipStatus ASC, role ASC)` | 後台儀表板 |

---

## 5. Role 權限對應

以下為**邏輯權限矩陣**，作為 Security Rules 設計依據。實際規則於下一階段文件撰寫。

### 5.1 權限符號

- `R` = Read
- `W` = Write（含 create / update）
- `D` = Delete（軟刪除）
- `—` = 無權限
- `self` = 僅限本人 / 自己相關資料

### 5.2 矩陣

| Collection | owner | admin | annual_member | monthly_member | coach | pending |
|---|---|---|---|---|---|---|
| `users` | R/W/D | R/W | R / W(self limited) | R(self) / W(self limited) | R(self + students) / W(self limited) | R(self) / W(self limited) |
| `bookings` | R/W/D | R/W/D | R / W(self) | R / W(self, hard only) | R / W(self + students) | R |
| `events` | R/W/D | R/W/D | R | R | R | R |
| `payments` | R/W/D | R/W/D | R | R(self) | R(self + students) | — |
| `expenses` | R/W/D | R/W/D | R | — | — | — |
| `annualReports` | R | R | R (excl. coachStats) | — | — | — |
| `settings` | R/W | R/W | R | R | R | R |
| `auditLogs` | R | R | — | — | — | — |

### 5.3 細部權限說明

**`users.W(self limited)`**：會員本人僅可修改 `displayName`、`ntrp`、`preferredPosition`、`coachId`。其餘欄位由管理層維護。

**`bookings.W(self, hard only)`**：月費會員僅能建立 `surface = hard` 的 booking，除非 `users.clayAccess = true`。

**`bookings.W(self + students)`**：教練可為自己學生（`users.coachId == 該教練 userId`）建立 booking。

**`payments.R(self + students)`**：教練可讀自己學生的繳費紀錄。

**`annualReports R (excl. coachStats)`**：年費會員可看年度報表，但 `coachStats` 欄位過濾掉。

**`bookings` 時間限制**：所有 W/D 操作必須在 `now < startAt` 才允許；時段開始後一律不可改。

---

## 6. Booking Query Structure

預約相關查詢是系統最高頻的場景，獨立列出。

### 6.1 主要查詢場景

| 場景 | Query | 對應 Index |
|---|---|---|
| **Day View** | `where date == '2026-05-19' order by startTime asc` | `(date, startTime)` 單欄位即可 |
| **Week View** | `where date >= '2026-05-18' and date <= '2026-05-24' order by date, startTime` | `(date, startTime)` |
| **Month View** | `where date >= '2026-05-01' and date <= '2026-05-31'` | `(date, startTime)` |
| **某場地當日佔用** | `where date == X and court == Y and status == 'active'` | `(date, court, status)` |
| **個人預約歷史** | `where actualUser == userId order by startAt desc limit 50` | `(actualUser, startAt)` |
| **代掛紀錄查詢** | `where bookedBy == userId and isProxyBooking == true` | `(bookedBy, isProxyBooking)` |
| **教練看學生預約** | 先查 `users where coachId == coachUserId` 取得 studentIds，再 `bookings where actualUser in [...studentIds]` | 兩段式 query |
| **未來時段（用於阻擋修改）** | `where actualUser == userId and startAt > now order by startAt asc` | `(actualUser, startAt)` |

### 6.2 時段衝突檢查

新增 booking 時必須檢查同場地同時段是否已存在 active 紀錄：

```
query:
  collection: bookings
  where date == newBooking.date
  where court == newBooking.court
  where status == 'active'
  where startAt < newBooking.endAt
  where endAt > newBooking.startAt
```

> 注意：Firestore 不支援同一 query 對兩個不同欄位做不等式查詢。故實務上會以 `(date, court)` 縮窄範圍後，在 client 端做時間區間判斷，或於 Cloud Function 內以交易方式驗證。

### 6.3 視圖資料結構（前端期望接收）

不在 Firestore 直接儲存，而是 client 取得後組裝成下列結構供 Calendar Layer 渲染：

```
WeekViewData {
  weekStart: '2026-05-18',
  weekEnd: '2026-05-24',
  days: [
    {
      date: '2026-05-18',
      bookings: [Booking, ...],
      events: [Event, ...]
    },
    ...
  ]
}
```

`bookings` 與 `events` 來自兩個 collection，分別查詢後在 client 合併渲染。

---

## 7. Annual Report Aggregation Structure

### 7.1 聚合策略

年度報表採「**預先聚合**」策略：每日由 scheduled job（建議 02:00 執行）重算當年度 `annualReports/{currentYear}`，避免每次開啟報表時都跑大量 query。

### 7.2 聚合流程

```
1. 取得 year = 當前年度
2. 設定 periodStart = year-01-01 00:00, periodEnd = year-12-31 23:59
3. 並行查詢：
   a. payments where date in periodRange
   b. expenses where date in periodRange
   c. bookings where date in periodRange and status == 'active'
   d. events where date in periodRange
   e. users where createdAt in periodRange
4. 聚合：
   - income.byType:    payments groupBy type (排除 donation)
   - income.byMonth:   payments groupBy month
   - expense.byCategory: expenses groupBy category
   - expense.byMonth:    expenses groupBy month
   - donation:          payments where type == 'donation'
   - events.byMode:     bookings groupBy mode
   - courtUsage:        bookings groupBy court, sum (endAt - startAt)
   - membership:        users groupBy role
   - coachStats:        bookings where mode == 'coaching' groupBy coach
5. 寫入 annualReports/{year}
6. 更新 lastComputedAt
```

### 7.3 即時觸發（事件驅動補強）

除每日全量重算外，下列事件**即時觸發**單一年度報表更新（避免使用者剛繳費卻看不到更新）：

- `payments` 新增 / 修改 / 刪除
- `expenses` 新增 / 修改 / 刪除

實作方式：Cloud Function trigger，僅更新對應 `byType` 與 `byMonth` 切片，不做全量重算。

### 7.4 跨年度查詢

若需多年度比較，由 client 端分別讀取 `annualReports/2025`、`annualReports/2026` 兩份文件後組裝，不在 Firestore 端做跨文件聚合。

---

## 8. 衍生規則與系統行為

幾個跨 collection 的系統行為，獨立列出以避免散落。

### 8.1 會員狀態每日更新

Scheduled job（建議 00:30 執行）：

```
for each user in users:
  if user.role == 'annual_member':
    user.membershipStatus = (annualExpiresAt >= today) ? 'active' : 'expired'
  if user.role == 'monthly_member':
    user.membershipStatus = (monthlyExpiresAt >= today) ? 'active' : 'expired'
```

只更新 `membershipStatus` 與 `updatedAt`，不動其他欄位。

### 8.2 月費滾動計算

當 `payments` 寫入 `type = monthly`：

```
newExpiresAt = max(user.monthlyExpiresAt, payment.date) + 1 month
user.monthlyExpiresAt = newExpiresAt
payment.affectsMembershipUntil = newExpiresAt
```

> 例：user 原到期日 5/28，於 5/15 再繳一次 → 新到期日為 6/28（從原到期日延伸，而非從繳費日起算）。
> 若 user 已 expired（例：到期日 4/28，今天 5/15 才繳）→ 新到期日為 6/15（從繳費日起算）。

### 8.3 年費統一到期日

當 `payments` 寫入 `type = annual`：

```
paymentYear = year of payment.date
user.annualExpiresAt = paymentYear-12-31 23:59
payment.affectsMembershipUntil = user.annualExpiresAt
```

不論幾月繳費，到期日一律為當年 12/31。

### 8.4 Booking 鎖定

Scheduled job（每 15 分鐘）：

```
for each booking where lockedAfterStart == false and startAt <= now:
  booking.lockedAfterStart = true
```

鎖定後該文件即使 owner / admin 也只能讀，不能改、不能刪。

---

## 附錄 A：Enum 對照

| 類別 | 值 |
|---|---|
| `users.role` | `owner` / `admin` / `annual_member` / `monthly_member` / `coach` / `pending` |
| `users.membershipStatus` | `active` / `expired` / `pending` |
| `bookings.court` / `events.court` | `hard_a` / `hard_b` / `clay_a` / `clay_b` |
| `bookings.surface` / `events.surface` | `hard` / `clay` |
| `bookings.mode` | `normal` / `coaching` / `group_class` / `pickleball` / `event_lock` |
| `bookings.status` | `active` / `cancelled` |
| `payments.type` | `monthly` / `annual` / `donation` / `event` |
| `events.colorTag` | `clay_red` / `blue` / `yellow_dot` / `green_dot` |

---

## 附錄 B：時間 / 日期欄位約定

- **`date`**：字串格式 `YYYY-MM-DD`，用於 query 與分組，UI 直接可讀
- **`startTime` / `endTime`**：字串格式 `HH:mm`，24 小時制，30 分鐘對齊
- **`startAt` / `endAt`**：Firestore `timestamp`，用於精確比較與排序
- **`createdAt` / `updatedAt` / `recordedAt`**：Firestore `timestamp`
- **時區**：全系統假設 `Asia/Taipei`，前端不做時區轉換顯示

雙重儲存（`date` + `startAt`）的目的：`date` 給 Firestore query 用（單純字串比對快、可分組），`startAt` 給排序與時段比較用。

---

## 附錄 C：未涵蓋於本文件、留待後續處理

下列項目刻意未在本文件定義，避免提前綁定設計：

1. **Firestore Security Rules** → 下一份文件 `Deta_Security_Rules.md`
2. **Cloud Functions 具體實作** → 下一份文件 `Deta_Cloud_Functions.md`
3. **前端元件結構** → 下一份文件 `Deta_UI_Components.md`
4. **Design Tokens（顏色、字體、間距）** → 下一份文件 `Deta_Design_System.md`

本文件僅定義「資料長什麼樣子」與「資料之間怎麼關聯」，不定義「介面長什麼樣子」與「規則怎麼執行」。

---

*本文件為 Deta 專案資料層的單一事實來源。所有後續 Schema 變更皆須以本文件為基礎進行版本管理。*
