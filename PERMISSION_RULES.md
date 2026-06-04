# PERMISSION_RULES.md — 清心網球系統權限邏輯

> 整理日期：2026-06-04
> 來源：`Deta/index.html` 的實際判斷式（`isAdminLike`、`_currentRole`、`_canEnter`、各 action function）。
> ⚠️ 本文件描述的是**前端 JavaScript 的權限判斷**。後端（Firestore Rules）目前形同未設防，見最後一段與 CURRENT_STATUS.md。

---

## 重要釐清：實際只有 4 種角色

任務清單列了 owner / admin / coach / **finance** / member 五種，但**程式裡沒有 `finance` 這個角色**。

- `role` 欄位實際只會是：**`owner`、`admin`、`coach`、`member`**。
- 「財務（finance）」是一個**畫面 / 功能分頁**，不是身份。財務功能的權限是用 `isAdminLike()`（owner 或 admin）控管，沒有獨立的財務人員角色。
- 另有 `pending` 出現在 status（會籍狀態），不是 role。

> 如果你**想要**一個「只能管財務、不能管會員」的專責財務角色，那是「待開發」項目，目前不存在。見本文件最後「建議」。

---

## 角色權限總表

| 功能 | owner | admin | coach | member |
|---|:---:|:---:|:---:|:---:|
| 進入系統（`_canEnter`） | ✅ 永遠 | ✅ 永遠 | 需 active/approved | 需 active/approved |
| 看週/日/月預約表 | ✅ | ✅ | ✅ | ✅ |
| 建立一般/匹克球預約 | ✅ | ✅ | ✅ | ✅ |
| 預約**紅土場** clay_a/b | ✅ | ✅ | ❌ | ❌ |
| 建立**團課** groupClass | ✅ | ✅ | ❌ | ❌ |
| 建立**活動鎖場** event_lock | ✅ | ✅ | ❌ | ❌ |
| 建立**教學** teaching | ✅ | ✅ | ✅（自己當教練） | ❌ |
| 取消**自己**的預約 | ✅ | ✅ | ✅ | ✅ |
| 取消**他人**預約 / 作廢(void) | ✅ | ✅ | ❌ | ❌ |
| **會員管理**（核准/拒絕/離會/封鎖） | ✅ | ✅ | ❌ | ❌ |
| 設定角色 → coach / member | ✅ | ✅ | ❌ | ❌ |
| 設定角色 → **admin** | ✅ 限 owner | ❌ | ❌ | ❌ |
| **永久刪除**會員 | ✅ 限 owner | ❌ | ❌ | ❌ |
| 編輯會員正式姓名 | ✅ | ✅ | ❌ | ❌ |
| **財務**：看 / 新增 / 編輯 / 刪除 / 匯出 CSV | ✅ | ✅ | ❌ | ❌ |
| **公告**：新增 / 編輯 / 刪除 | ✅ | ✅ | ❌ | ❌ |
| 指派/編輯**自己的**學生 coachStudents | ✅ | ✅ | ✅（限本人） | ❌ |
| 指派/編輯**任何教練的**學生 | ✅ | ✅ | ❌ | ❌ |

---

## 判斷邏輯（程式對照）

```js
// 角色判斷核心（index.html）
function isAdminLike(){           // 等同「管理權限」
  var role = currentUser ? currentUser.role : (DEV_ROLE || null);
  return role === 'owner' || role === 'admin';
}
function _currentRole(){          // 取目前角色字串
  return currentUser ? currentUser.role : (DEV_ROLE || null);
}
```

幾乎所有「管理動作」都先檢查 `isAdminLike()`。需要更細分時才另外比對 `_currentRole() === 'owner'` 或 `=== 'coach'`。

### owner 專屬（admin 也不能做）
- 設定 / 撤銷 admin 身份（`setAdminRole`、`setMemberRole` 內 `newRole==='admin'` 檢查）。
- 永久刪除會員（`permanentDeleteMember`，且僅限 `status==='deleted'` 的會員、不能刪自己、不能刪其他 owner）。
- owner 身份**不可被任何人變更或降級**（`setMemberRole` 內 `targetRole==='owner'` 直接擋）。

### admin 的天花板
- admin 不能對 owner 或其他 admin 做離會/封鎖（`removeMember`、`blockMember` 內 `operator==='admin' && target.role in (owner,admin)` → 擋）。
- admin **數量上限 8 位**（`setMemberRole` / `setAdminRole` 內 `>=8` 檢查）。

### coach 的特例
- 教學預約：coach 建立時，`coachId` 自動填自己 uid（表單的教練選擇對 coach 隱藏）。
- coachStudents：coach 只能操作 `coachId === 自己uid` 的學生資料。

### member（一般會員）
- 只能預約一般場（硬地）的一般/匹克球/教學參與，管理自己的預約。
- 看得到公告、財務「總覽數字」？→ 財務分頁的新增/匯出按鈕對非 admin 隱藏（`renderFinance` 內 `isAdmin ? '' : 'none'`），但**畫面層的隱藏不等於資料層的保護**（見下）。

---

## 登入後的狀態分流（`_routeByStatus`）

通過 `_canEnter` → 進主畫面；否則依 status 導到不同攔截畫面：

| status | 導向畫面 |
|---|---|
| active / approved（或 owner/admin） | ✅ 主畫面 |
| pending | 待審核畫面 |
| rejected | 已拒絕畫面 |
| resigned | 已離會畫面 |
| blocked / banned | 已封鎖畫面 |
| deleted / removed / expired / inactive | 可重新申請畫面 |

---

## ⚠️ 最關鍵的安全提醒：前端權限 ≠ 真正的權限

上面所有規則**都只是前端 JavaScript 的判斷**。它們決定「按鈕顯不顯示、動作前要不要跳提示」，但：

1. **專案裡找不到 `firestore.rules` 檔，`firebase.json` 也沒有 firestore rules 設定。** 代表後端規則不在版控內、由 Console 手動管理，狀態不明。
2. README 自述：「Firestore 暫時開放讀寫，**不可部署至 production**」——但系統已經上線。
3. 系統**沒有整合 Firebase Auth**，Firestore 規則無法用 `request.auth.uid` 做人別驗證。

**推論：Firestore 很可能處於「測試模式 / 全開放讀寫」。**
若屬實，任何知道專案設定的人都能繞過前端、直接讀寫整個資料庫（會員個資、財務金額、改自己的 role 成 owner）。

> 這是整個系統最高優先的風險，但**本次任務不修規則**。請先到 Firebase Console → Firestore → Rules 確認目前實際規則內容，再決定下一步。詳見 `CURRENT_STATUS.md` 的「最危險的地方」。

---

## 給未來的建議（暫不執行）

- 若要真正的「finance 財務專責角色」，需要：(a) 在 `role` 列舉加入 `finance`；(b) 把財務功能的 `isAdminLike()` 改成 `isAdminLike() || role==='finance'`；(c) **同時**在 Firestore Rules 落地，否則只是裝飾。
- 在動 role 機制前，先補上 Firestore Rules 與 Firebase Auth，否則前端怎麼改都沒有實質防護。
