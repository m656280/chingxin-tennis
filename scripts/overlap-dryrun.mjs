/**
 * overlap-dryrun.mjs  — Phase 1: 重疊預約 Dry-Run 掃描（只讀，不寫入）
 *
 * 掃描 Firestore bookings collection，找出同場地同日期時間重疊的預約，
 * 依移場優先規則判斷哪一筆移，輸出完整清單。
 *
 * 移場優先規則（依序）：
 *   1. 教學預約（mode=teaching）優先保留原場地
 *   2. 一般預約（mode=general）優先移場
 *   3. 若兩筆都是教學 或 都是一般 → 較早建立的保留，較晚的移
 *
 * ── 使用方式 ────────────────────────────────────────────────────────────────
 *   cd .../qingxin-club-system/Deta/scripts
 *   npm init -y && npm install firebase
 *   node overlap-dryrun.mjs
 *
 *   結果存成 overlap-dryrun-result.json，供 Phase 2 使用
 * ────────────────────────────────────────────────────────────────────────────
 */

import { initializeApp }                    from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";
import { writeFileSync }                     from "fs";

// ── Firebase config（同 index.html）──────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyC9EE8rQN-hiJUYBthcvumf-DKerfMwRYg",
  projectId:         "chingxin-tennis",
  storageBucket:     "chingxin-tennis.firebasestorage.app",
  messagingSenderId: "631543657695",
  appId:             "1:631543657695:web:348bdcc19bace490c6256a",
};

// ── 常數 ────────────────────────────────────────────────────────────────────
const ACTIVE_STATUSES = new Set(["active", "confirmed", "pending", "approved"]);

const COURT_PAIR = {
  hard_a: "hard_b",
  hard_b: "hard_a",
  clay_a: "clay_b",
  clay_b: "clay_a",
};

const COURT_LABEL = {
  hard_a: "Hard A", hard_b: "Hard B",
  clay_a: "Clay A", clay_b: "Clay B",
};

// ── helpers ──────────────────────────────────────────────────────────────────
function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isActive(status) {
  return ACTIVE_STATUSES.has((status || "active").toLowerCase());
}

function overlaps(a, b) {
  return timeToMin(a.startTime) < timeToMin(b.endTime) &&
         timeToMin(a.endTime)   > timeToMin(b.startTime);
}

function isTeaching(b) {
  return (b.mode || "").toLowerCase() === "teaching";
}

function createdAtMs(b) {
  const raw = b.createdAt;
  if (!raw) return 0;
  if (raw.toMillis) return raw.toMillis();
  if (raw.seconds)  return raw.seconds * 1000;
  if (typeof raw === "string") return new Date(raw).getTime();
  return 0;
}

function createdAtStr(b) {
  const ms = createdAtMs(b);
  return ms ? new Date(ms).toISOString() : "unknown";
}

/**
 * 決定重疊 pair 中哪一筆留、哪一筆移。
 * 回傳 { stay, move }。
 *
 * 優先規則：
 *   1. teaching > non-teaching → teaching 留
 *   2. 同類型 → 較早建立的留
 */
function decideMover(a, b) {
  const aTeach = isTeaching(a);
  const bTeach = isTeaching(b);
  if (aTeach && !bTeach) return { stay: a, move: b };
  if (bTeach && !aTeach) return { stay: b, move: a };
  // same priority → earlier stays
  return createdAtMs(a) <= createdAtMs(b)
    ? { stay: a, move: b }
    : { stay: b, move: a };
}

/** 檢查某場地某時段是否空閒 */
function isCourtFree(bksByCourtDate, court, date, start, end, excludeIds) {
  const key = `${court}|${date}`;
  for (const b of (bksByCourtDate[key] || [])) {
    if (excludeIds.has(b.id)) continue;
    if (!isActive(b.status))  continue;
    if (timeToMin(start) < timeToMin(b.endTime) &&
        timeToMin(end)   > timeToMin(b.startTime)) return false;
  }
  return true;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Firestore Booking Overlap Dry-Run ===");
  console.log(`Project: ${FB_CONFIG.projectId}\n`);

  const app = initializeApp(FB_CONFIG);
  const db  = getFirestore(app);

  // 1. 抓全部 bookings
  console.log("Fetching bookings...");
  const snap = await getDocs(collection(db, "bookings"));
  const allBookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Total fetched: ${allBookings.length}\n`);

  // 2. 只保留 active，依 (court|date) 建 index
  const bksByCourtDate = {};
  for (const b of allBookings) {
    if (!isActive(b.status)) continue;
    const key = `${b.court}|${b.date}`;
    (bksByCourtDate[key] ||= []).push(b);
  }

  // 3. 找重疊 pair，套用優先規則
  const processedPairs = new Set();
  const autoMove       = [];
  const manualReview   = [];

  for (const [, bks] of Object.entries(bksByCourtDate)) {
    if (bks.length < 2) continue;

    for (let i = 0; i < bks.length; i++) {
      for (let j = i + 1; j < bks.length; j++) {
        const a = bks[i], b = bks[j];
        const pairKey = [a.id, b.id].sort().join("|");
        if (processedPairs.has(pairKey)) continue;
        if (!overlaps(a, b)) continue;
        processedPairs.add(pairKey);

        const { stay, move } = decideMover(a, b);
        const altCourt = COURT_PAIR[move.court];

        const entry = {
          bookingId:      move.id,
          originalCourt:  COURT_LABEL[move.court] || move.court,
          date:           move.date,
          startTime:      move.startTime,
          endTime:        move.endTime,
          mode:           move.mode || "—",
          primaryName:    move.primaryName || "—",
          createdBy:      move.createdBy || "",
          createdByName:  move.createdByName || move.createdBy || "—",
          players:        Array.isArray(move.players) ? move.players : (move.createdBy ? [move.createdBy] : []),
          createdAt:      createdAtStr(move),
          collidesWithId: stay.id,
          staysName:      stay.primaryName || "—",
          staysMode:      stay.mode || "—",
          moveReason:     isTeaching(stay) && !isTeaching(move)
                          ? "teaching_priority"
                          : "earlier_created_stays",
        };

        if (!altCourt) {
          manualReview.push({ ...entry, reason: "no_alt_court" });
          continue;
        }

        entry.suggestedCourt = COURT_LABEL[altCourt] || altCourt;

        if (isCourtFree(bksByCourtDate, altCourt, move.date,
                        move.startTime, move.endTime, new Set([move.id]))) {
          autoMove.push(entry);
        } else {
          manualReview.push({ ...entry, reason: "alt_court_also_busy" });
        }
      }
    }
  }

  // 4. 輸出報告
  console.log(`=== autoMoveCandidate (${autoMove.length}) ===`);
  if (autoMove.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of autoMove) {
      console.log(`  bookingId:      ${r.bookingId}`);
      console.log(`  date:           ${r.date}  ${r.startTime}–${r.endTime}`);
      console.log(`  court:          ${r.originalCourt} → ${r.suggestedCourt}`);
      console.log(`  mode:           ${r.mode}`);
      console.log(`  primaryName:    ${r.primaryName}`);
      console.log(`  createdByName:  ${r.createdByName}`);
      console.log(`  createdAt:      ${r.createdAt}`);
      console.log(`  collidesWith:   ${r.collidesWithId} (${r.staysName} / ${r.staysMode})`);
      console.log(`  moveReason:     ${r.moveReason}`);
      console.log();
    }
  }

  console.log(`=== manualReview (${manualReview.length}) ===`);
  if (manualReview.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of manualReview) {
      const alt = r.suggestedCourt || "n/a";
      console.log(`  bookingId:      ${r.bookingId}`);
      console.log(`  date:           ${r.date}  ${r.startTime}–${r.endTime}`);
      console.log(`  court:          ${r.originalCourt}  (alt: ${alt} — ${r.reason})`);
      console.log(`  mode:           ${r.mode}`);
      console.log(`  primaryName:    ${r.primaryName}`);
      console.log(`  collidesWith:   ${r.collidesWithId} (${r.staysName})`);
      console.log(`  reason:         ${r.reason}`);
      console.log();
    }
  }

  // 5. 存 JSON
  const result = {
    generatedAt: new Date().toISOString(),
    totalBookingsFetched: allBookings.length,
    autoMove,
    manualReview,
  };
  writeFileSync("overlap-dryrun-result.json", JSON.stringify(result, null, 2), "utf8");
  console.log("=== Saved: overlap-dryrun-result.json ===");
  console.log("確認清單後，執行 overlap-phase2-write.mjs --confirm 進行正式移場。");

  process.exit(0);
}

main().catch(e => { console.error("ERROR:", e); process.exit(1); });
