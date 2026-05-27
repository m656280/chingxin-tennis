/**
 * lineauth/index.js
 * Firebase Cloud Functions — LINE OAuth 2.0 Callback
 * Codebase: lineauth  (disallowLegacyRuntimeConfig: true, Node 24)
 *
 * ── Flow ─────────────────────────────────────────────────────────────
 * 1. LINE redirects here with ?code=AUTH_CODE after user approves
 * 2. Exchange code → access_token  (LINE token API, requires channel secret)
 * 3. Get LINE profile  (userId, displayName, pictureUrl)
 * 4. Upsert  members/{lineUserId}  in Firestore
 *    - New member:  status:'pending',  role:'member'
 *    - Existing:    update displayName / pictureUrl / lastLoginAt only
 * 5. Create  sessions/{randomToken}  (30-day expiry)
 * 6. Redirect →  APP_BASE_URL?session=TOKEN  (frontend picks it up)
 *
 * ── Setup before first deploy ────────────────────────────────────────
 *   # Secret (channel secret never goes in code or .env committed to git)
 *   firebase functions:secrets:set LINE_CHANNEL_SECRET
 *
 *   # Non-secret env vars — create lineauth/.env  (gitignored)
 *   LINE_CHANNEL_ID=2009941241
 *   APP_BASE_URL=https://court-board-c1e29.web.app
 *
 *   # Register Callback URL in LINE Developer Console → your channel:
 *   https://asia-east1-court-board-c1e29.cloudfunctions.net/lineCallback
 *   (confirm exact URL from Firebase Console after first deploy)
 *
 * ── Firestore Security Rules needed ─────────────────────────────────
 *   match /sessions/{token} {
 *     allow read: if true;   // token is 256-bit random — acts as capability
 *     allow write: if false; // only this Function may create sessions
 *   }
 *   match /members/{uid} {
 *     allow read: if true;   // tighten once Firebase Auth is added
 *     allow write: if false;
 *   }
 * ────────────────────────────────────────────────────────────────────
 */

'use strict';

const { setGlobalOptions } = require('firebase-functions');
const { onRequest }        = require('firebase-functions/https');
const { initializeApp }    = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const https       = require('https');
const querystring = require('querystring');
const crypto      = require('crypto');

// ── Firebase Admin init ───────────────────────────────────────────────
initializeApp();
const db = getFirestore();

setGlobalOptions({ maxInstances: 10, region: 'asia-east1' });

// ── Runtime config (from .env + Firebase Secret Manager) ─────────────
const LINE_CHANNEL_ID  = process.env.LINE_CHANNEL_ID  || '2009941241';
const APP_BASE_URL     = process.env.APP_BASE_URL     || 'https://court-board-c1e29.web.app';
// LINE_CHANNEL_SECRET injected via secrets array — accessed as process.env.LINE_CHANNEL_SECRET

// This URL must match exactly what is registered in LINE Developer Console
const CALLBACK_URL = 'https://asia-east1-court-board-c1e29.cloudfunctions.net/lineCallback';

const SESSION_EXPIRY_DAYS = 30;

// ── Native HTTPS helpers (no extra npm dependencies) ─────────────────
function httpsPost(url, formData) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const body    = querystring.stringify(formData);
    const options = {
      hostname: u.hostname,
      path:     u.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return reject(new Error(`Non-JSON from LINE (${res.statusCode}): ${raw.slice(0, 200)}`)); }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGetJson(url, bearerToken) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers:  { Authorization: `Bearer ${bearerToken}` },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return reject(new Error(`Non-JSON from LINE (${res.statusCode}): ${raw.slice(0, 200)}`)); }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── LINE OAuth Callback ───────────────────────────────────────────────
exports.lineCallback = onRequest(
  {
    region:  'asia-east1',
    secrets: ['LINE_CHANNEL_SECRET'],
    cors:    false,
  },
  async (req, res) => {
    const { code, error, error_description: errorDesc } = req.query;

    // LINE returned an error (user denied, etc.)
    if (error) {
      console.error('[lineCallback] LINE denied:', error, errorDesc);
      return res.redirect(`${APP_BASE_URL}?auth_error=${encodeURIComponent(errorDesc || error)}`);
    }

    if (!code) {
      console.error('[lineCallback] Missing code param');
      return res.redirect(`${APP_BASE_URL}?auth_error=missing_code`);
    }

    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    if (!channelSecret) {
      console.error('[lineCallback] LINE_CHANNEL_SECRET not configured');
      return res.redirect(`${APP_BASE_URL}?auth_error=server_config`);
    }

    try {
      // ── Step 1: Exchange auth code for access_token ─────────────────
      const tokenRes = await httpsPost('https://api.line.me/oauth2/v2.1/token', {
        grant_type:    'authorization_code',
        code,
        redirect_uri:  CALLBACK_URL,
        client_id:     LINE_CHANNEL_ID,
        client_secret: channelSecret,
      });

      if (tokenRes.status !== 200) {
        console.error('[lineCallback] Token exchange failed:', JSON.stringify(tokenRes.data));
        return res.redirect(`${APP_BASE_URL}?auth_error=token_exchange`);
      }
      const { access_token: accessToken } = tokenRes.data;

      // ── Step 2: Fetch LINE profile ───────────────────────────────────
      const profileRes = await httpsGetJson('https://api.line.me/v2/profile', accessToken);
      if (profileRes.status !== 200) {
        console.error('[lineCallback] Profile fetch failed:', JSON.stringify(profileRes.data));
        return res.redirect(`${APP_BASE_URL}?auth_error=profile_fetch`);
      }

      const {
        userId:      lineUserId,
        displayName: lineDisplayName,
        pictureUrl:  linePictureUrl,
      } = profileRes.data;

      if (!lineUserId) {
        return res.redirect(`${APP_BASE_URL}?auth_error=no_user_id`);
      }

      // ── Step 3: Upsert Firestore members/{lineUserId} ────────────────
      const memberRef  = db.collection('members').doc(lineUserId);
      const memberSnap = await memberRef.get();
      const now        = FieldValue.serverTimestamp();

      if (!memberSnap.exists) {
        // First login — create as pending; admin must approve before access
        await memberRef.set({
          lineUserId,
          displayName: lineDisplayName,
          pictureUrl:  linePictureUrl  || '',
          status:      'pending',
          role:        'member',
          createdAt:   now,
          approvedAt:  null,
          approvedBy:  null,
          lastLoginAt: now,
        });
        console.info('[lineCallback] New member created:', lineUserId, lineDisplayName);
      } else {
        // Returning member — refresh display info only; never touch status/role
        await memberRef.update({
          displayName: lineDisplayName,
          pictureUrl:  linePictureUrl  || '',
          lastLoginAt: now,
        });
      }

      // ── Step 4: Create session (30-day expiry) ───────────────────────
      const sessionToken = crypto.randomBytes(32).toString('hex'); // 256-bit
      const expiresAt    = new Date(Date.now() + SESSION_EXPIRY_DAYS * 864e5);

      await db.collection('sessions').doc(sessionToken).set({
        lineUserId,
        createdAt: now,
        expiresAt: Timestamp.fromDate(expiresAt),
      });

      // ── Step 5: Redirect to app with session token ───────────────────
      console.info('[lineCallback] Auth success for:', lineUserId);
      return res.redirect(`${APP_BASE_URL}?session=${sessionToken}`);

    } catch (err) {
      console.error('[lineCallback] Unexpected error:', err.message || err);
      return res.redirect(`${APP_BASE_URL}?auth_error=internal`);
    }
  }
);
