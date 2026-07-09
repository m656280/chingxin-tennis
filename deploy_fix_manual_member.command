#!/usr/bin/env bash
# Fix: 手動建立會員 PERMISSION_DENIED
# 部署內容：
#   1. firestore.rules v1.1 — members.create 新增 admin/owner 手動建立分支
#   2. hosting — index.html 加入 auth/role debug log
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_fix_manual_member.log"

echo "=== deploy fix: manual member permission ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

firebase deploy --only firestore:rules,hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?
echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
read -p "[Press Enter to close]"
