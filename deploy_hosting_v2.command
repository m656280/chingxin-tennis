#!/usr/bin/env bash
# 部署 hosting（MANUAL_MEMBER_CALLABLE_V4）
# 內建防呆：部署前先確認本機 index.html 真的含有新版本標記，
# 避免 Dropbox 尚未同步完成就把舊檔部署上去（上次的問題）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_hosting_v2.log"
MARKER="MANUAL_MEMBER_CALLABLE_V4"

echo "=== deploy hosting v2 ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

echo "--- 0/2 部署前檢查：本機 index.html 是否為新版 ---" | tee -a "$LOG"
N=$(grep -c "$MARKER" index.html)
D=$(grep -c "collection('members').add" index.html)
echo "版本標記出現次數: ${N} (need >= 2)" | tee -a "$LOG"
echo "舊直接寫入殘留次數: ${D} (need = 0)" | tee -a "$LOG"
# 防呆必須嚴格：數字不合法（空值）也視為失敗
case "$N" in ''|*[!0-9]*) N=0;; esac
case "$D" in ''|*[!0-9]*) D=999;; esac
if [ "$N" -lt 2 ] || [ "$D" -ne 0 ]; then
  echo "!! index.html 不是新版（Dropbox 可能還沒同步完）。" | tee -a "$LOG"
  echo "!! 請等 Dropbox 同步圖示變綠勾後再執行本腳本。已中止，未部署。" | tee -a "$LOG"
  read -p "[Press Enter to close]"
  exit 1
fi

echo "--- 1/2 檢查通過，部署 hosting ---" | tee -a "$LOG"
firebase deploy --only hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?

echo "--- 2/2 驗證線上版本 ---" | tee -a "$LOG"
sleep 3
LIVE=$(curl -s "https://chingxin-tennis.web.app/index.html?cb=$(date +%s)" | grep -c "$MARKER")
echo "線上版本標記出現次數: ${LIVE} (>=2 = 部署成功且為新版)" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
read -p "[Press Enter to close]"
