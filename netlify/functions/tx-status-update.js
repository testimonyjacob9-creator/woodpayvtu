// netlify/functions/tx-status-update.js
// Updates a transaction's status in Firestore using Admin SDK.
// Firestore rules block client writes to transactions (allow update: if isAdmin())
// so this is the only trusted path.
//
// Body: { idToken, uid, txId, status, providerRef?, providerExtra? }
// Returns: { ok } or { ok: false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const VALID_STATUSES = ['success', 'failed', 'pending', 'refunded'];

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

  const { idToken, uid, txId, status, providerRef, providerExtra } = body;

  if (!idToken || !uid || !txId || !status) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  if (!VALID_STATUSES.includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: `Invalid status: ${status}` }) };
  }

  // Verify ID token
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' })
    };
  }

  if (decoded.uid !== uid) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Token/uid mismatch.' })
    };
  }

  try {
    const txRef = db.collection('transactions').doc(txId);
    const txSnap = await txRef.get();

    if (!txSnap.exists) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Transaction not found.' })
      };
    }

    // Verify this transaction belongs to the requesting user
    if (txSnap.data().userId !== uid) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Not your transaction.' })
      };
    }

    const update = {
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (providerRef) update.providerRef = providerRef;
    if (providerExtra) update.providerExtra = providerExtra;

    await txRef.update(update);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (e) {
    console.error('tx-status-update error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
