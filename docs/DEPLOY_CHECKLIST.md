# Deploy 前自我驗證清單

> **強制規則：任何 Agent 修改程式後，禁止直接 commit / push / deploy。**
> 必須依序完成以下五項驗證，全部通過才允許執行部署。

---

## Checklist

### 1. Syntax Check

- [ ] HTML 結構無破損（tag 正確關閉、無意外截斷）
- [ ] JavaScript 語法正確
  - 字串引號：單引號內的單引號必須用 `\'` 跳脫
  - 字串引號：雙引號內的雙引號必須用 `\"` 跳脫
  - 反斜線 escape：Python 寫入時 `\'` 只留下 `'`，需特別驗證
  - Template literal：backtick 與 `${}` 對齊
  - 函數括號、大括號、方括號正確對應
- [ ] 無未關閉的字串、無孤立的運算符號

**驗證指令：**

```bash
# 從 HTML 提取主要 JS block 並用 Node 驗證
python3 -c "
import re
with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()
scripts = re.findall(r'<script(?:\s[^>]*)?>(.+?)</script>', content, re.DOTALL)
biggest = max(scripts, key=len)
biggest = re.sub(r'^.*?<script[^>]*>', '', biggest, count=1, flags=re.DOTALL)
with open('/tmp/app_check.js', 'w', encoding='utf-8') as f:
    f.write(biggest)
"
node --check /tmp/app_check.js && echo 'PASS' || echo 'FAIL'
```

---

### 2. Console Error Check

- [ ] 本地或 Chrome DevTools 確認 Console 無紅色錯誤
- [ ] 特別確認：Firebase 初始化、Firestore 查詢、頁面渲染相關 error

**無法本地開啟時的替代驗證：**
- 在 HTML 中搜尋所有 `innerHTML =`、`+=`、`.map(`、`.forEach(` 的字串拼接，確認引號未破壞
- 搜尋所有 `onclick="..."` 屬性中的引號用法

---

### 3. Mobile Render Check

- [ ] 場地頁（`#screen-court`）可正常渲染：Logo、週/月切換、日期列、時間軸
- [ ] 預約頁可正常顯示
- [ ] 管理頁不空白（Admin 可見修復工具、會員管理）
- [ ] 財務頁不空白（收入支出列表、PDF 匯出按鈕）
- [ ] 我的頁面正常（頭像、角色、到期日）

---

### 4. Critical Flow Check

- [ ] 登入後可切換底部導航各頁面
- [ ] 場地頁：日期列（週/月）正常
- [ ] 場地頁：時間軸、場地欄位正常
- [ ] 場地頁：預約資料顯示正常（若有資料）
- [ ] 管理頁：不空白，各 section 可展開
- [ ] 財務頁：收支列表、統計正常

---

### 5. 自我驗證完成後才能 Commit

- [ ] 以上 1–4 項全部通過
- [ ] 確認本次修改範圍符合預期（`git diff` 或逐行比對）
- [ ] Commit message 清楚描述修改內容與原因

---

## 若任何一項失敗

1. **禁止 deploy**
2. 回報錯誤原因（檔案、行數、錯誤訊息）
3. 修復後重新執行完整 Checklist

---

## 高風險修改額外規則

以下修改除必須通過本 Checklist 外，還需使用者明確批准才能執行：

| 類型 | 範例 |
|------|------|
| Firestore Schema 變更 | 新增/移除欄位、改變型別 |
| Firebase Security Rules | 任何規則異動 |
| 權限/角色邏輯 | `isAdminLike()`、role 判斷 |
| 財務計算邏輯 | 金額、帳期、到期日計算 |
| 預約規則 | 時段、衝突判斷、自動移場 |
| 任何資料刪除操作 | batch delete、status→void 批次 |

---

## 已知 Gotcha（避免重蹈）

### Python 寫入引號跳脫

Python `str.replace()` 中使用 `\'` 時，寫入檔案後只剩 `'`，不會保留反斜線。

**錯誤範例（導致 JS syntax error）：**
```python
content = content.replace(old, "onclick=\"_state.status='idle'\"")
# 寫入檔案後：onclick="_state.status='idle'"
# JS 解析：字串內裸露的 ' → SyntaxError
```

**正確做法：**
```python
# 方法一：雙層跳脫
content = content.replace(old, r"onclick=\"_state.status=\'idle\'\"")
# 方法二：改用雙引號包住字串值
content = content.replace(old, 'onclick="_state.status=&apos;idle&apos;"')
# 方法三：改寫成不需 onclick 的寫法
```

**事後必做：** 修改後用 `grep -n "status='idle'"` 確認無裸露單引號。

### Edit Tool 不支援中文 / Emoji / 反斜線

含有中文字符、emoji、或 `\s` 等 regex pattern 的字串，`Edit` tool 無法正確匹配 `old_string`。
必須改用 Python `str.replace()` in bash。

---

*最後更新：2026-06-12*
