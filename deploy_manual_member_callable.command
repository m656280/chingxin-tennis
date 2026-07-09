#!/usr/bin/env bash
# 手動建立會員改為 callable function 架構
# 部署內容：
#   1. functions: createManualMember（onCall v2, asia-east1, Admin SDK 寫入 members）
#   2. hosting: index.html — _doCreateManualMember 改呼叫 callable + functions-compat SDK
# 不部署 firestore rules（本次不動 rules）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_manual_member_callable.log"

echo "=== deploy: createManualMember callable ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

firebase deploy --only functions:createManualMember,hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?
echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
read -p "[Press Enter to close]"
