// netlify/functions/list-withdrawals.js
// Returns recent withdrawal requests (pending, success, rejected) for the
// admin panel's Withdrawals tab. Mirrors list-settlements.js.
//
// Body: { idToken, uid, status?, limit? }
// Returns: { ok, withdrawals: [...] } or { ok: false, error }

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

  const { idToken, uid, status, limit } = body;
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
    let q = db.collection('withdrawals').orderBy('createdAt', 'desc');
    if (status && ['pending', 'success', 'rejected'].includes(status)) {
      q = db.collection('withdrawals').where('status', '==', status).orderBy('createdAt', 'desc');
    }
    const snap = await q.limit(Math.min(Number(limit) || 50, 200)).get();

    const withdrawals = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        userId: data.userId || null,
        userEmail: data.userEmail || null,
        amount: data.amount || 0,
        bankName: data.bankName || null,
        bankCode: data.bankCode || null,
        accountNumber: data.accountNumber || null,
        accountName: data.accountName || null,
        status: data.status || 'pending',
        note: data.note || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        approvedAt: data.approvedAt ? data.approvedAt.toDate().toISOString() : null,
        rejectedAt: data.rejectedAt ? data.rejectedAt.toDate().toISOString() : null
      };
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, withdrawals }) };
  } catch (e) {
    console.error('list-withdrawals error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
