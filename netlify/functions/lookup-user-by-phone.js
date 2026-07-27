// netlify/functions/lookup-user-by-phone.js
// Returns just the recipient's display name for a phone number — nothing
// else (no email, balance, uid). Requires the caller to be signed in, so
// this can't be used for anonymous phone-number enumeration/scraping.
//
// Body:   { idToken, phone }
// Returns: { ok: true, name } or { ok: false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  const db = admin.firestore();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, phone } = body;
  if (!idToken || !phone) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }

  const cleanPhone = String(phone).trim();

  try {
    const q = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    if (q.empty) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'No WoodPay user found with that phone number.' }) };
    }
    const doc = q.docs[0];
    if (doc.id === decoded.uid) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: "That's your own number." }) };
    }
    const data = doc.data();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, name: data.name || 'WoodPay user' }) };
  } catch (e) {
    console.error('lookup-user-by-phone error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Lookup failed — please try again.' }) };
  }
};
