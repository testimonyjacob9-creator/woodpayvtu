// netlify/functions/baseline-settlement.js
// One-time admin action: clears the historical Bigisub backlog by marking
// every currently-unsettled successful order as settled WITHOUT sending
// any money. Use this once, right after turning the settlement system on,
// for orders that were already paid to Bigisub some other way before this
// system existed. From then on, the settlement tracker only reflects new
// orders going forward.
//
// Body: { idToken, uid }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { markBaseline } = require('./_settlementCore');

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

  const { idToken, uid } = body;
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
    const result = await markBaseline();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (e) {
    console.error('baseline-settlement error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
