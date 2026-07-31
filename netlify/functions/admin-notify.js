// netlify/functions/admin-notify.js
//
// Backend for admin.html's "Send in-app notification" panel. Was missing
// entirely — the frontend called this URL but no function existed, so
// Netlify returned its default 404 HTML page instead of JSON, surfacing
// in the admin UI as "Unexpected token '<', <!DOCTYPE... is not valid JSON".
//
// Writes directly via _notify.js's notifyUser(), the same helper used by
// the wallet-funding webhook — so these land in the exact same
// users/{uid}/notifications subcollection the bell already listens to.
//
// Body: { idToken, targetUid, title, body, type }
//   targetUid: a specific user's uid, or 'all' to broadcast to every user.
// Returns: { ok, sent } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');

const VALID_TYPES = ['info', 'success', 'warning', 'danger'];

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const { idToken, targetUid, title, body: msgBody } = body;
  const type = VALID_TYPES.includes(body.type) ? body.type : 'info';

  if (!idToken || !targetUid || !title || !msgBody) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  const db = admin.firestore();

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' }) };
  }

  // Same admin-authorization pattern as manual-settlement.js.
  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Not authorized as admin.' }) };
  }

  try {
    if (targetUid === 'all') {
      const usersSnap = await db.collection('users').get();
      let sent = 0;
      // Chunk to avoid hammering Firestore with hundreds of concurrent
      // writes at once if the user base is large.
      const uids = usersSnap.docs.map((d) => d.id);
      const CHUNK = 50;
      for (let i = 0; i < uids.length; i += CHUNK) {
        const chunk = uids.slice(i, i + CHUNK);
        await Promise.all(chunk.map((uid) =>
          notifyUser(admin, db, uid, { title, body: msgBody, type, url: '/' })
        ));
        sent += chunk.length;
      }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, sent }) };
    }

    // Single user — confirm they exist first so a typo'd uid doesn't
    // silently report success.
    const userSnap = await db.collection('users').doc(targetUid).get();
    if (!userSnap.exists) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'User not found.' }) };
    }

    await notifyUser(admin, db, targetUid, { title, body: msgBody, type, url: '/' });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, sent: 1 }) };
  } catch (e) {
    console.error('admin-notify error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
