// netlify/functions/trigger-settlement.js
// Lets a logged-in admin run the Bigisub settlement on demand from
// admin.html (e.g. "preview" what's owed, or force a run outside the
// normal daily schedule). Requires the same admins/{uid} allowlist used by
// wallet-credit.js.
//
// Body: { idToken, uid, dryRun? }
// Returns: whatever runSettlement() returns, or { ok: false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { runSettlement } = require('./_settlementCore');

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, uid, dryRun, force } = body;
  if (!idToken || !uid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing idToken/uid' }) };
  }

  const db = admin.firestore();
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' }) };
  }
  if (decoded.uid !== uid) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Token/uid mismatch.' }) };
  }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Not authorized as admin.' }) };
  }

  try {
    const result = await runSettlement({ dryRun: !!dryRun, force: !!force });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (e) {
    console.error('trigger-settlement error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
