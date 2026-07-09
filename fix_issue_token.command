#!/usr/bin/env bash
# Fix: issueFirebaseToken HTTP 500
# 依序做四件事：
#   1. 抓 issueFirebaseToken 最近的 error log（確認 500 的實際 stack）
#   2. 重建 lineauth/node_modules（同 functions/ 的 Dropbox 占位檔問題，先預防部署 timeout）
#   3. 部署 lineauth codebase（含 issueFirebaseToken 錯誤詳情改良）+ hosting
#   4. 再抓一次 log 供比對
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/fix_issue_token.log"

echo "=== fix issueFirebaseToken ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

echo "" | tee -a "$LOG"
echo "--- 1/4 抓最近的 function log（重點看 error stack）---" | tee -a "$LOG"
firebase functions:log --only issueFirebaseToken 2>&1 | tail -40 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "--- 2/4 重建 lineauth/node_modules（防 Dropbox 占位檔造成部署 timeout）---" | tee -a "$LOG"
cd "$SCRIPT_DIR/lineauth"
rm -rf node_modules
npm install --no-audit --no-fund 2>&1 | tail -3 | tee -a "$LOG"
xattr -w com.dropbox.ignored 1 node_modules 2>/dev/null || true

echo "" | tee -a "$LOG"
echo "--- 3/4 部署 lineauth + hosting ---" | tee -a "$LOG"
cd "$SCRIPT_DIR"
firebase deploy --only functions:lineauth,hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?

echo "" | tee -a "$LOG"
echo "Firebase exit code: ${EXITCODE}" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
echo ""
echo "▶ 部署後請在手機重試一次，STEP3 FAIL 的訊息會直接顯示 500 的真正原因"
read -p "[Press Enter to close]"
