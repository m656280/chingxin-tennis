#!/usr/bin/env bash
# 部署 Firestore Rules v1.2（修正臨打 day_pass 型值白名單，MK 2026-07-12 指示修正）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_rules_v1_2.log"
cd "$SCRIPT_DIR"

echo "=== deploy firestore rules v1.2 ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"

echo "--- 0/1 部署前檢查 ---" | tee -a "$LOG"
N=$(grep -c "v1.2-stopgap" firestore.rules)
D=$(grep -c "'day_pass'" firestore.rules)
echo "v1.2 標記: ${N} (need >= 1) / day_pass 白名單: ${D} (need >= 1)" | tee -a "$LOG"
case "$N" in ''|*[!0-9]*) N=0;; esac
case "$D" in ''|*[!0-9]*) D=0;; esac
if [ "$N" -lt 1 ] || [ "$D" -lt 1 ]; then
  echo "!! firestore.rules 不是 v1.2（Dropbox 可能未同步完）。已中止。" | tee -a "$LOG"
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
