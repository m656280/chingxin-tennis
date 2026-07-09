# Archive/

此目錄用於存放開發過程中產生的暫時性檔案：
- `.command`：舊版 deploy / diagnose / fix 腳本
- `.log`：deploy 和診斷 log
- 一次性腳本與測試檔

以下檔案建議從根目錄移入此目錄：

## 建議執行的移動指令

在 `Deta/` 目錄執行：

```bash
# === .command 腳本（保留 deploy.command）===
mv p1_deploy.command p1_deploy2.command p1_deploy3.command \
   p1_deploy4.command p1_deploy5.command p1_deploy6.command \
   p1_deploy7.command p1_deploy8.command p1_deploy9.command \
   p1_deploy10.command p1_deploy11.command p1_deploy12.command \
   p1_deploy13_debug.command p1_deploy14.command \
   p1_debug_deploy.command \
   p1_deploy_hosting.command \
   p1_diagnose.command p1_diagnose2.command p1_diagnose3.command \
   p1_fix_deploy.command p1_spy_deploy.command \
   p1_test_loadstack.command p1_test_loadstack2.command \
   p1_test_loadstack3.command p1_test_loadstack4.command \
   p1_test_node.command \
   fix_permissions.command fix_xattr.command \
   Archive/

# === .log 檔案 ===
mv deploy10.log deploy11.log deploy12.log deploy13_debug.log \
   deploy14.log deploy_hosting.log \
   diagnose_deploy.log diagnose2_deploy.log diagnose3_deploy.log \
   firebase-debug.log firebase_deploy_debug.log \
   index_diag.log \
   loadstack_test.log loadstack_test2.log loadstack_test4.log \
   node_require_test.log \
   Archive/

# === 其他 ===
mv diag_prefix.js test_manifest4.json Archive/
mv "截圖 2026-05-18 下午5.15.47.png" Archive/
```

## scripts/ 目錄

`scripts/` 下的檔案（overlap migration 腳本）已於 2026-06-05 執行過，
建議移入此目錄或移入 `Archive/scripts/`：

```bash
mv scripts/ Archive/
```

---

> 移動前請確認根目錄仍保留以下核心檔案：
> `index.html`, `firebase.json`, `.firebaserc`, `firestore.rules`,
> `firestore.rules.v2.draft`, `firestore.indexes.json`,
> `manifest.json`, `deploy.command`

*清心網球系統 / chingxin-tennis — 由 Claude Cowork 建立 2026-06-18*
