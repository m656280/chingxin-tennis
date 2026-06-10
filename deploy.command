#!/usr/bin/env bash
DETA="/Users/m656280/Library/CloudStorage/Dropbox/MK's AI Agent/2026/qingxin-club-system/Deta"
cd "$DETA"

echo "=== 清除殘留鎖定 ==="
rm -f .git/index.lock && echo "removed main index.lock" || true
git worktree prune --expire=now 2>&1 || true

echo "=== git status ==="
git status

echo "=== git add ==="
git add index.html release.sh README.md

echo "=== git commit ==="
git commit -m "fix: bypass window.open in LINE/iOS for PDF export; add release.sh"

echo "=== git push ==="
git push

echo "=== firebase deploy ==="
firebase deploy --only hosting

echo ""
echo "✅ Done! https://chingxin-tennis.web.app"
