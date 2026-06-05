/**
 * overlap-phase2-write.mjs  — Phase 2: 正式移場（需明確確認才寫入）
 *
 * 讀取 overlap-dryrun-result.json（Phase 1 產生），
 * 對 autoMove 清單執行以下 Firestore 寫入：
 *
 *   1. 更新 bookings/{id}：
 *      - court            → 新場地 key（e.g. "hard_b"）
 *      - movedFromCourt   → 原場地 key
 *      - movedReason      → "overlap_conflict_auto_fix"
 *      - movedAt          → serverTimestamp()
 *      - movedBy          → "system"
 *      - history          → arrayUnion({ type, fromCourt, toCourt, ... })
 *
 *   2. 新增 notifications/{auto-id}（每位 player 各一筆）：
 *      - 通知類型 court_auto_moved
 *      - read: false，30 天後過期
 *
 * ── 使用方式 ────────────────────────────────────────────────────────────────
 *   node overlap-phase2-write.mjs           ← 預覽（不寫入）
 *   node overlap-phase2-write.mjs --confirm ← 正式寫入 Firestore
 * ────────────────────────────────────────────────────────────────────────────
 */

import { initializeApp }                             from "firebase/app";
import { getFirestore, doc, updateDoc,
         collection, addDoc,
         arrayUnion, serverTimestamp, Timestamp }    from "firebase/firestore";
import { readFileSync }                              from "fs";

// ── Firebase config ──────────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyC9EE8rQN-hiJUYBthcvumf-DKerfMwRYg",
  projectId:         "chingxin-tennis",
  storageBucket:     "chingxin-tennis.firebasestorage.app",
  messagingSenderId: "631543657695",
  appId:             "1:631543657695:web:348bdcc19bace490c6256a",
};

// ── court label → internal key ───────────────────────────────────────────────
const LABEL_TO_KEY = {
  "Hard A": "hard_a", "Hard B": "hard_b",
  "Clay A": "clay_a", "Clay B": "clay_b",
};

// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const confirmed = process.argv.includes("--confirm");

  console.log("=== Phase 2: 正式移場 ===");
  console.log(confirmed
    ? "⚠  --confirm 已傳入，將正式寫入 Firestore"
    : "（預覽模式：沒有 --confirm，不寫入）");
  console.log();

  // 讀取 Phase 1 結果
  let result;
  try {
    result = JSON.parse(readFileSync("overlap-dryrun-result.json", "utf8"));
  } catch {
    console.error("找不到 overlap-dryrun-result.json，請先執行 overlap-dryrun.mjs");
    process.exit(1);
  }

  const { autoMove, generatedAt } = result;
  console.log(`Dry-run generated: ${generatedAt}`);
  console.log(`autoMove count:    ${autoMove.length}`);
  console.log();

  if (autoMove.length === 0) {
    console.log("沒有需要移場的預約，結束。");
    process.exit(0);
  }

  const app = initializeApp(FB_CONFIG);
  const db  = getFirestore(app);

  let successCount = 0;
  let errorCount   = 0;

  for (const r of autoMove) {
    const fromKey = LABEL_TO_KEY[r.originalCourt]  || r.originalCourt;
    const toKey   = LABEL_TO_KEY[r.suggestedCourt] || r.suggestedCourt;

    console.log(`  Booking: ${r.bookingId}`);
    console.log(`    ${r.date}  ${r.startTime}–${r.endTime}  ${r.originalCourt} → ${r.suggestedCourt}`);
    console.log(`    mode: ${r.mode}  name: ${r.primaryName}`);
    console.log(`    players to notify: ${(r.players || []).join(", ") || "(none in record)"}`);

    if (!confirmed) {
      console.log("    [dry] 跳過（需 --confirm）\n");
      continue;
    }

    try {
      const now = Timestamp.now();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // ── 1. 更新 booking doc ─────────────────────────────────────────────
      await updateDoc(doc(db, "bookings", r.bookingId), {
        court:          toKey,
        movedFromCourt: fromKey,
        movedReason:    "overlap_conflict_auto_fix",
        movedAt:        serverTimestamp(),
        movedBy:        "system",
        history: arrayUnion({
          type:           "court_auto_moved",
          fromCourt:      fromKey,
          toCourt:        toKey,
          fromCourtLabel: r.originalCourt,
          toCourtLabel:   r.suggestedCourt,
          reason:         "overlap_conflict_auto_fix",
          createdAt:      now,          // Timestamp.now() — serverTimestamp() 不能在 arrayUnion 內使用
          createdBy:      "system",
        }),
      });
      console.log("    ✓ booking 已更新（court + history）");

      // ── 2. 通知每位 player ──────────────────────────────────────────────
      const notifyUids = Array.isArray(r.players) && r.players.length > 0
        ? r.players
        : (r.createdBy ? [r.createdBy] : []);

      for (const uid of notifyUids) {
        await addDoc(collection(db, "notifications"), {
          uid,
          type:           "court_auto_moved",
          action:         "court_auto_moved",
          bookingId:      r.bookingId,
          date:           r.date,
          startTime:      r.startTime,
          endTime:        r.endTime,
          fromCourt:      fromKey,
          fromCourtLabel: r.originalCourt,
          court:          toKey,
          courtLabel:     r.suggestedCourt,
          message:        `您的預約場地已由系統自動調整：${r.originalCourt} → ${r.suggestedCourt}（原因：同場地時段重疊，教學預約優先保留）`,
          createdAt:      serverTimestamp(),
          expiresAt,
          read:           false,
        });
        console.log(`    ✓ 通知已建立 → ${uid}`);
      }

      successCount++;
    } catch (e) {
      console.error(`    ✗ 失敗: ${e.message}`);
      errorCount++;
    }
    console.log();
  }

  if (confirmed) {
    console.log(`=== 完成：${successCount} 筆成功，${errorCount} 筆失敗 ===`);
    if (successCount > 0) {
      console.log("記得部署 index.html 讓前端也更新：");
      console.log("  firebase deploy --only hosting --project chingxin-tennis");
    }
  } else {
    console.log("預覽完成。確認無誤後：");
    console.log("  node overlap-phase2-write.mjs --confirm");
  }

  process.exit(0);
}

main().catch(e => { console.error("ERROR:", e); process.exit(1); });
