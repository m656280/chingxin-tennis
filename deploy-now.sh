#!/bin/bash
# 部署清心系統 - 修復 PDF 報表按鈕
cd "$(dirname "$0")"
git add index.html
git commit -m "fix: 修復 PDF 報表頁兩個按鈕失效（返回+列印）"
firebase deploy --only hosting
