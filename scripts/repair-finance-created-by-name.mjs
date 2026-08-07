/**
 * 一次性修復 financialRecords.createdByName。
 *
 * 預設為 Dry Run，只讀不寫：
 *   node repair-finance-created-by-name.mjs
 *
 * 正式執行必須明確帶入 --confirm：
 *   node repair-finance-created-by-name.mjs --confirm
 */

import { initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  updateDoc,
} from "firebase/firestore";

const FB_CONFIG = {
  apiKey:            "AIzaSyC9EE8rQN-hiJUYBthcvumf-DKerfMwRYg",
  projectId:         "chingxin-tennis",
  storageBucket:     "chingxin-tennis.firebasestorage.app",
  messagingSenderId: "631543657695",
  appId:             "1:631543657695:web:348bdcc19bace490c6256a",
};

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createdAtMs(record) {
  if (record.createdAt && typeof record.createdAt.toMillis === "function") {
    return record.createdAt.toMillis();
  }
  return 0;
}

function recordSummary(record) {
  const ms = createdAtMs(record);
  return {
    documentId: record.id,
    date: cleanString(record.date) || "(empty)",
    createdAt: ms ? new Date(ms).toISOString() : "(unknown)",
    createdByUid: cleanString(record.createdByUid) || "(empty)",
    createdByName: cleanString(record.createdByName) || "(empty)",
  };
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  const app = initializeApp(FB_CONFIG);
  const db = getFirestore(app);

  console.log("=== financialRecords.createdByName repair ===");
  console.log(confirmed
    ? "MODE: CONFIRMED WRITE"
    : "MODE: DRY RUN (read-only; no Firestore writes)");

  const financeSnap = await getDocs(collection(db, "financialRecords"));
  const allRecords = financeSnap.docs.map((snapshot) => ({
    id: snapshot.id,
    ...snapshot.data(),
  }));

  const candidates = allRecords.filter((record) =>
    cleanString(record.createdByUid) && !cleanString(record.createdByName));

  const memberByUid = new Map();
  for (const uid of [...new Set(candidates.map((record) => cleanString(record.createdByUid)))]) {
    const memberSnap = await getDoc(doc(db, "members", uid));
    memberByUid.set(uid, memberSnap.exists()
      ? { exists: true, realName: cleanString(memberSnap.data().realName) }
      : { exists: false, realName: "" });
  }

  const repairable = [];
  const unresolved = [];
  for (const record of candidates) {
    const uid = cleanString(record.createdByUid);
    const member = memberByUid.get(uid);
    if (!member || !member.exists) {
      unresolved.push({ ...recordSummary(record), reason: "member_not_found" });
      continue;
    }
    if (!member.realName) {
      unresolved.push({ ...recordSummary(record), reason: "realName_missing" });
      continue;
    }
    repairable.push({ ...recordSummary(record), realName: member.realName });
  }

  const countsByCreator = new Map();
  for (const record of repairable) {
    const key = record.createdByUid;
    const current = countsByCreator.get(key) || {
      createdByUid: key,
      realName: record.realName,
      count: 0,
    };
    current.count += 1;
    countsByCreator.set(key, current);
  }

  const missingSorted = candidates.slice().sort((a, b) => createdAtMs(a) - createdAtMs(b));
  const normalSorted = allRecords
    .filter((record) => cleanString(record.createdByName))
    .sort((a, b) => createdAtMs(a) - createdAtMs(b));

  console.log(`Scanned total: ${allRecords.length}`);
  console.log(`Planned repairs: ${repairable.length}`);
  console.log(`Unresolved: ${unresolved.length}`);
  console.log();

  console.log("=== Creator mapping ===");
  if (!countsByCreator.size) {
    console.log("(none)");
  } else {
    for (const item of countsByCreator.values()) {
      console.log(`${item.createdByUid} | ${item.realName} | ${item.count}`);
    }
  }
  console.log();

  console.log("=== Planned document IDs ===");
  if (!repairable.length) {
    console.log("(none)");
  } else {
    for (const item of repairable) console.log(item.documentId);
  }
  console.log();

  console.log("=== Unresolved ===");
  if (!unresolved.length) {
    console.log("(none)");
  } else {
    for (const item of unresolved) {
      console.log(`${item.documentId} | ${item.createdByUid} | ${item.reason}`);
    }
  }
  console.log();

  console.log("=== Timeline evidence ===");
  console.log("First missing:", JSON.stringify(
    missingSorted.length ? recordSummary(missingSorted[0]) : null));
  console.log("Last normal:", JSON.stringify(
    normalSorted.length ? recordSummary(normalSorted[normalSorted.length - 1]) : null));

  if (!confirmed) {
    console.log();
    console.log("Dry Run complete. No Firestore documents were modified.");
    return;
  }

  let updated = 0;
  const failed = [];
  for (const item of repairable) {
    try {
      const recordRef = doc(db, "financialRecords", item.documentId);
      const latestSnap = await getDoc(recordRef);
      if (!latestSnap.exists()) {
        failed.push({ documentId: item.documentId, reason: "record_not_found" });
        continue;
      }
      const latest = latestSnap.data();
      if (cleanString(latest.createdByUid) !== item.createdByUid) {
        failed.push({ documentId: item.documentId, reason: "createdByUid_changed" });
        continue;
      }
      if (cleanString(latest.createdByName)) {
        failed.push({ documentId: item.documentId, reason: "createdByName_already_set" });
        continue;
      }
      await updateDoc(recordRef, { createdByName: item.realName });
      updated += 1;
    } catch (error) {
      failed.push({
        documentId: item.documentId,
        reason: error && error.message ? error.message : String(error),
      });
    }
  }

  console.log();
  console.log(`Updated: ${updated}`);
  console.log(`Failed during write: ${failed.length}`);
  for (const item of failed) console.log(`${item.documentId} | ${item.reason}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("ERROR:", error);
    process.exit(1);
  });
