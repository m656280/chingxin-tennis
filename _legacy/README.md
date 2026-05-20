# Legacy — Court Board Prototype

這個資料夾保留了 Deta 專案早期的 **Court Board** 原型。

## 內容

- `index.html`：vanilla HTML，直接掛 LIFF SDK 與 Firebase compat SDK
- `js/main.js`：所有邏輯（單一檔案）
- `css/main.css`：所有樣式

## 為什麼保留

技術棧已轉換為 Vite + React + TypeScript，但這份原型的 court 視覺、roster 排版、bottom sheet 互動，仍有設計參考價值。Phase 3 開始做 Calendar Layer 與 Booking 時可回來參考。

## 不要動

- 不對 `_legacy/` 內任何檔案做修改
- 新系統不從這裡 import 任何資源
- 部署時排除此資料夾
