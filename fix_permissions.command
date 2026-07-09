#!/usr/bin/env bash
# Fix execute permissions on firebase-functions.js (stripped by file edit tools)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/lineauth/node_modules/firebase-functions/lib/bin/firebase-functions.js"

echo "Current permissions:"
ls -la "$BIN"

echo ""
echo "Setting execute permissions..."
chmod a+x "$BIN"

echo ""
echo "New permissions:"
ls -la "$BIN"
echo ""
echo "Done."
read -p "[Press Enter to close]"
