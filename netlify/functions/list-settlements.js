// netlify/functions/list-settlements.js
// Returns recent settlement batches (success + failed) for the admin panel.
//
// Body: { idToken, uid, limit? }
// Returns: { ok, settlements: [...] } or { ok: false, error }

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
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { idToken, uid, limit } = body;
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
    const snap = await db.collection('settlements')
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Number(limit) || 20, 100))
      .get();

    const settlements = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        batchRef: data.batchRef || null,
        total: data.total || 0,
        count: data.count || 0,
        status: data.status || 'unknown',
        error: data.error || null,
        flwTransferId: data.flwTransferId || null,
        flwStatus: data.flwStatus || null,
        resolvedAccountName: data.resolvedAccountName || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      };
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, settlements }) };
  } catch (e) {
    console.error('list-settlements error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
