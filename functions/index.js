/**
 * Firebase Cloud Functions — Deta / 清心網球協會
 * Phase 1: LINE Login → Firebase Custom Token + Firestore member upsert
 *
 * Deploy:
 *   firebase functions:config:set line.channel_id="YOUR_CHANNEL_ID"
 *   firebase deploy --only functions
 *
 * Environment variables (set via Firebase config):
 *   line.channel_id  — LINE Login channel ID (public, used for LIFF token verification)
 *
 * NOTE: LINE channel secret is NOT needed here.
 *       LIFF ID token verification only requires the channel_id (client_id).
 *       The secret is only needed for server-side code flow (not LIFF).
 */

'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const https     = require('https');
const querystring = require('querystring');

admin.initializeApp();
const db = admin.firestore();

// ── LINE API endpoints ─────────────────────────────────────────────────
const LINE_VERIFY_HOST = 'api.line.me';
const LINE_VERIFY_PATH = '/oauth2/v2.1/verify';

/**
 * Verify a LIFF ID token against the LINE API.
 * Uses Node built-in https to avoid any npm dependency.
 * Returns the decoded payload (sub, name, picture, email, …).
 */
function verifyLiffIdToken(idToken, channelId){
  return new Promise(function(resolve, reject){
    const body = querystring.stringify({
      id_token:  idToken,
      client_id: channelId,
    });
    const options = {
      hostname: LINE_VERIFY_HOST,
      path:     LINE_VERIFY_PATH,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, function(res){
      let raw = '';
      res.on('data', function(chunk){ raw += chunk; });
      res.on('end', function(){
        let json;
        try { json = JSON.parse(raw); } catch(e){ return reject(new Error('LINE API returned non-JSON: '+raw)); }
        if(res.statusCode !== 200){
          return reject(new Error('LINE verify failed ('+res.statusCode+'): '+(json.error_description||json.error||raw)));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Cloud Function ─────────────────────────────────────────────────────
exports.createFirebaseToken = functions
  .region('asia-east1')
  .https.onCall(async function(data, context){

    const idToken = data && data.idToken;
    if(!idToken){
      throw new functions.https.HttpsError('invalid-argument', 'Missing idToken');
    }

    // Read LINE channel ID from Firebase config
    const channelId = (functions.config().line || {}).channel_id;
    if(!channelId){
      console.error('[createFirebaseToken] line.channel_id is not set. Run: firebase functions:config:set line.channel_id="YOUR_ID"');
      throw new functions.https.HttpsError('internal', 'Server configuration error');
    }

    // 1. Verify LIFF ID token with LINE
    let linePayload;
    try {
      linePayload = await verifyLiffIdToken(idToken, channelId);
    } catch(err){
      console.error('[createFirebaseToken] LINE verify error:', err.message);
      throw new functions.https.HttpsError('unauthenticated', 'LINE token verification failed: '+err.message);
    }

    const lineUserId = linePayload.sub;
    if(!lineUserId){
      throw new functions.https.HttpsError('unauthenticated', 'LINE token has no sub claim');
    }

    const displayName = linePayload.name    || '';
    const pictureUrl  = linePayload.picture || '';

    // 2. Firebase UID = "line:<lineUserId>"  (stable, collision-free)
    const uid = 'line:' + lineUserId;

    // 3. Upsert Firestore members/{uid}
    const memberRef = db.collection('members').doc(uid);
    const memberSnap = await memberRef.get();

    let memberRole   = 'member';
    let memberStatus = 'pending';

    if(!memberSnap.exists){
      // ── New member: create with pending status ──
      await memberRef.set({
        uid:         uid,
        lineUserId:  lineUserId,
        displayName: displayName,
        pictureUrl:  pictureUrl,
        status:      'pending',    // admin must approve → 'active'
        role:        'member',
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
        approvedAt:  null,
        approvedBy:  null,
        lastSeenAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      console.info('[createFirebaseToken] New member created:', uid, displayName);
    } else {
      // ── Existing member: refresh profile only; never overwrite status/role ──
      const existing = memberSnap.data();
      memberRole   = existing.role   || 'member';
      memberStatus = existing.status || 'pending';
      await memberRef.update({
        displayName: displayName,
        pictureUrl:  pictureUrl,
        lastSeenAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // 4. Create Firebase custom token
    //    Include role + status as claims so the client can read them from the token
    //    (though the client should always read from Firestore for authoritative state)
    const customToken = await admin.auth().createCustomToken(uid, {
      lineUserId:  lineUserId,
      role:        memberRole,
      status:      memberStatus,
    });

    return { customToken: customToken };
  });
