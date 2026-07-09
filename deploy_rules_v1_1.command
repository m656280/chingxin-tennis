#!/usr/bin/env bash
# 部署 Firestore Rules v1.1-stopgap（MK 已於 2026-07-09 確認上線）
# 僅部署 rules，不動 hosting / functions。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_rules_v1_1.log"
cd "$SCRIPT_DIR"

echo "=== deploy firestore rules v1.1 ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"

echo "--- 0/1 部署前檢查：rules 檔為 v1.1 ---" | tee -a "$LOG"
N=$(grep -c "v1.1-stopgap" firestore.rules)
echo "v1.1 標記: ${N} (need >= 1)" | tee -a "$LOG"
case "$N" in ''|*[!0-9]*) N=0;; esac
if [ "$N" -lt 1 ]; then
  echo "!! firestore.rules 不是 v1.1，已中止。" | tee -a "$LOG"
  read -p "[Press Enter to close]"
  exit 1
fi

echo "--- 1/1 部署 firestore:rules ---" | tee -a "$LOG"
firebase deploy --only firestore:rules 2>&1 | tee -a "$LOG"
EXITCODE=$?
echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
exit 0
