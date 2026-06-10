#!/usr/bin/env bash
# release.sh — 一鍵 commit + push + firebase deploy
# 用法：./release.sh "commit message"
#       ./release.sh             （預設 commit message：chore: update）

set -e

MSG="${1:-chore: update}"

echo "📦 Committing: $MSG"
git add .
git commit -m "$MSG"
git push

echo "🚀 Deploying to Firebase Hosting..."
firebase deploy --only hosting

echo "✅ Done. https://chingxin-tennis.web.app"
