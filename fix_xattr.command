#!/usr/bin/env bash
# Fix extended attributes on firebase-functions.js (remove quarantine etc.)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/lineauth/node_modules/firebase-functions/lib/bin/firebase-functions.js"

echo "=== Current xattr ==="
xattr -l "$BIN" 2>/dev/null || echo "(none)"

echo ""
echo "=== Removing all xattr ==="
xattr -c "$BIN" 2>/dev/null
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

echo ""
echo "=== After xattr removal ==="
xattr -l "$BIN" 2>/dev/null || echo "(none)"

echo ""
echo "=== Permissions ==="
ls -la "$BIN"

echo ""
echo "Done. Now try deploy."
read -p "[Press Enter to close]"
