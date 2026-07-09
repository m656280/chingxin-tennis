#!/usr/bin/env bash
# Fix: functions 部署失敗（User code failed to load / Cannot determine backend specification / Timeout 10000）
#
# Root cause（已驗證）：Dropbox 把 functions/node_modules 大量檔案轉成「線上暫存」占位檔
#（2,938 個 .js 中 1,916 個本機無實體內容），Firebase CLI 載入 user code 時讀檔失敗而 timeout。
# index.js 程式碼本身無誤——乾淨環境 103ms 即可載入並解析出 createManualMember endpoint。
#
# 此腳本做四件事：
#   1. 重建 functions/node_modules（本機實體檔案）
#   2. 設 Dropbox 忽略 node_modules，防止再被轉成占位檔（防復發）
#   3. 驗證 user code 可載入
#   4. 部署 functions:createManualMember + hosting
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/fix_functions_deploy.log"

echo "=== fix functions deploy ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "--- 1/4 重建 node_modules ---" | tee -a "$LOG"
cd "$SCRIPT_DIR/functions"
rm -rf node_modules
npm install --no-audit --no-fund 2>&1 | tail -5 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "--- 2/4 設 Dropbox 忽略 node_modules（防復發）---" | tee -a "$LOG"
xattr -w com.dropbox.ignored 1 node_modules 2>&1 | tee -a "$LOG" || true

echo "" | tee -a "$LOG"
echo "--- 3/4 驗證 user code 可載入 ---" | tee -a "$LOG"
node -e "
const t0 = Date.now();
const m  = require('./index.js');
console.log('user code 載入 OK（' + (Date.now()-t0) + 'ms）, exports:', Object.keys(m).join(','));
process.exit(0);
" 2>&1 | tee -a "$LOG"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  echo "!! user code 載入失敗，中止部署（請把上面錯誤貼給 Claude）" | tee -a "$LOG"
  read -p "[Press Enter to close]"
  exit 1
fi

echo "" | tee -a "$LOG"
echo "--- 4/4 部署 ---" | tee -a "$LOG"
cd "$SCRIPT_DIR"
firebase deploy --only functions:createManualMember,hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?
echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
read -p "[Press Enter to close]"
