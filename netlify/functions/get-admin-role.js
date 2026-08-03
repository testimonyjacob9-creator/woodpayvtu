// netlify/functions/get-admin-role.js
//
// Returns the caller's admin role. Exists because /admins is (correctly)
// fully locked to direct client reads in Firestore rules — this uses the
// Admin SDK, which bypasses those rules, to check on the client's behalf.
//
// Body: { idToken }
// Returns: { ok:true, isAdmin, role } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const { idToken } = body;
  if (!idToken) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing idToken' }) };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' }) };
  }

  const db = admin.firestore();
  const snap = await db.collection('admins').doc(decoded.uid).get();

  if (!snap.exists) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, isAdmin: false, role: null }) };
  }

  const role = snap.data().role === 'owner' ? 'owner' : 'subadmin';
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, isAdmin: true, role }) };
};
