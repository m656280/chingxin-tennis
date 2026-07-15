#!/usr/bin/env bash
# 部署 hosting（BOOKING_ACTIONS_FIX：進行中預約 取消/作廢 按鈕）
# 防呆：部署前確認本機 index.html 已含本次修正，避免 Dropbox 未同步就部署舊檔。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_booking_actions_fix.log"

echo "=== deploy booking actions fix ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

echo "--- 0/2 部署前檢查 ---" | tee -a "$LOG"
A=$(grep -c '>作廢預約</button>' index.html)
B=$(grep -c "_currentRole()!=='owner'){ showToast('預約已開始" index.html)
C=$(grep -c '僅開發者可強制作廢' index.html)
echo "詳情面板作廢按鈕: ${A} (need >= 1)" | tee -a "$LOG"
echo "已開始僅Owner取消守衛: ${B} (need >= 1)" | tee -a "$LOG"
echo "voidBooking Owner守衛: ${C} (need >= 1)" | tee -a "$LOG"
case "$A" in ''|*[!0-9]*) A=0;; esac
case "$B" in ''|*[!0-9]*) B=0;; esac
case "$C" in ''|*[!0-9]*) C=0;; esac
if [ "$A" -lt 1 ] || [ "$B" -lt 1 ] || [ "$C" -lt 1 ]; then
  echo "❌ 檢查失敗：index.html 不含本次修正（可能 Dropbox 尚未同步），中止部署。" | tee -a "$LOG"
  read -r -p "按 Enter 關閉..."
  exit 1
fi
echo "✅ 檢查通過" | tee -a "$LOG"

echo "--- 1/2 部署 hosting ---" | tee -a "$LOG"
npx firebase-tools deploy --only hosting 2>&1 | tee -a "$LOG"
RC=${PIPESTATUS[0]}

echo "--- 2/2 結果 ---" | tee -a "$LOG"
if [ "$RC" -eq 0 ]; then
  echo "✅ 部署完成" | tee -a "$LOG"
else
  echo "❌ 部署失敗（exit $RC），詳見 $LOG" | tee -a "$LOG"
fi
read -r -p "按 Enter 關閉..."
