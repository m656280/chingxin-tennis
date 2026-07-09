#!/usr/bin/env bash
# 部署 hosting（會員名冊匯出功能 ROSTER_EXPORT_V1）
# 結構沿用 deploy_hosting_v2.command：
# 防呆 1：index.html 必須含手動會員新版標記（避免 Dropbox 沒同步完部署到舊檔）
# 防呆 2：index.html 必須含會員名冊匯出功能
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/deploy_roster_v1.log"
M1="MANUAL_MEMBER_CALLABLE_V4"
M2="exportMemberRosterPDF"

echo "=== deploy roster v1 ===" | tee "$LOG"
echo "Date: $(date)" | tee -a "$LOG"
cd "$SCRIPT_DIR"

echo "--- 0/2 部署前檢查 ---" | tee -a "$LOG"
N1=$(grep -c "$M1" index.html)
N2=$(grep -c "$M2" index.html)
D=$(grep -c "collection('members').add" index.html)
echo "手動會員標記: ${N1} (need >= 2)" | tee -a "$LOG"
echo "名冊匯出標記: ${N2} (need >= 2)" | tee -a "$LOG"
echo "舊直接寫入殘留: ${D} (need = 0)" | tee -a "$LOG"
case "$N1" in ''|*[!0-9]*) N1=0;; esac
case "$N2" in ''|*[!0-9]*) N2=0;; esac
case "$D"  in ''|*[!0-9]*) D=999;; esac
if [ "$N1" -lt 2 ] || [ "$N2" -lt 2 ] || [ "$D" -ne 0 ]; then
  echo "!! index.html 不是預期版本（Dropbox 可能還沒同步完）。已中止，未部署。" | tee -a "$LOG"
  read -p "[Press Enter to close]"
  exit 1
fi

echo "--- 1/2 檢查通過，部署 hosting ---" | tee -a "$LOG"
firebase deploy --only hosting 2>&1 | tee -a "$LOG"
EXITCODE=$?

echo "--- 2/2 驗證線上版本 ---" | tee -a "$LOG"
sleep 3
LIVE1=$(curl -s "https://chingxin-tennis.web.app/index.html?cb=$(date +%s)" | grep -c "$M1")
LIVE2=$(curl -s "https://chingxin-tennis.web.app/index.html?cb=$(date +%s)" | grep -c "$M2")
echo "線上手動會員標記: ${LIVE1} (>=2 = OK)" | tee -a "$LOG"
echo "線上名冊匯出標記: ${LIVE2} (>=2 = OK)" | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "Firebase exit code: $EXITCODE" | tee -a "$LOG"
echo "=== DONE ===" | tee -a "$LOG"
exit 0
