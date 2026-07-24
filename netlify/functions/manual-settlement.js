// netlify/functions/manual-settlement.js
// For accounts where the Flutterwave Transfers API is blocked by mandatory
// IP whitelisting (Netlify's IPs rotate, so a permanent code-side fix needs
// a static-IP proxy — see _settlementCore.js STATIC_IP_PROXY_URL).
//
// This is the free, zero-setup alternative: the admin sends the exact
// amount to Bigisub manually through the Flutterwave dashboard (a normal
// logged-in action, never blocked by IP whitelisting), then confirms it
// here. This endpoint does NOT call Flutterwave at all — it only sums the
// same eligible transactions runSettlement() would have paid, marks them
// settled, and logs the batch with status 'manual' so it's clearly
// distinguished from a real API-initiated transfer in the history table.
//
// Body: { idToken, uid }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

function genBatchRef() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `MANUAL-${stamp}-${rand}`;
}

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
    const snap = await db.collection('transactions').where('status', '==', 'success').get();
    const eligible = [];
    snap.forEach((doc) => {
      const d = doc.data();
      if (d.settled === true) return;
      if (typeof d.buyPrice !== 'number' || d.buyPrice <= 0) return;
      eligible.push({ id: doc.id, buyPrice: d.buyPrice });
    });

    if (eligible.length === 0) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, skipped: true, reason: 'Nothing pending.', total: 0, count: 0 }) };
    }

    const total = eligible.reduce((s, t) => s + t.buyPrice, 0);
    const batchRef = genBatchRef();

    const CHUNK = 400;
    for (let i = 0; i < eligible.length; i += CHUNK) {
      const chunk = eligible.slice(i, i + CHUNK);
      const batch = db.batch();
      chunk.forEach((t) => {
        batch.update(db.collection('transactions').doc(t.id), {
          settled: true,
          settledAt: admin.firestore.FieldValue.serverTimestamp(),
          settlementBatchRef: batchRef,
          settledManually: true
        });
      });
      await batch.commit();
    }

    await db.collection('settlements').add({
      batchRef,
      total,
      count: eligible.length,
      status: 'manual',
      settledBy: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, total, count: eligible.length, batchRef }) };
  } catch (e) {
    console.error('manual-settlement error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
