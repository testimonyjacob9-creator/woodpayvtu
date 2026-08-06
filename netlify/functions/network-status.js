// netlify/functions/network-status.js
//
// Bigisub has no "network delivery rate" endpoint (already confirmed in
// index.html's fetchNetworkRate comment). Instead of showing nothing,
// this computes a real number from WoodPay's own order history: the
// success rate of the last 5 transactions for a given network + service
// type (e.g. "mtn" + "data"). Global across all users — this is meant to
// reflect the network's health right now, not any one person's luck.
//
// GET /.netlify/functions/network-status?network=mtn&type=data
// Returns: { ok, pct, sampleSize } — pct is null if there's no history yet.
//
// Deliberately returns only an aggregate percentage, never the underlying
// transaction docs — this endpoint has no auth, so it must not leak any
// user's order details.

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const VALID_TYPES = ['data', 'airtime', 'cable', 'electricity', 'betting', 'isp', 'rechargepin', 'resultchecker'];

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  const db = admin.firestore();
  const params = event.queryStringParameters || {};
  const network = String(params.network || '').toLowerCase();
  const type = String(params.type || '').toLowerCase();

  if (!network || !VALID_TYPES.includes(type)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing or invalid network/type' }) };
  }

  try {
    const snap = await db.collection('transactions')
      .where('network', '==', network)
      .where('type', '==', type)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    if (snap.empty) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, pct: null, sampleSize: 0 }) };
    }

    let successCount = 0;
    snap.forEach((doc) => {
      if (doc.data().status === 'success') successCount++;
    });
    const pct = Math.round((successCount / snap.size) * 100);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, pct, sampleSize: snap.size }) };
  } catch (e) {
    console.log('network-status: query failed:', e.message);
    // Firestore will reject this with a "needs an index" error the first
    // time this runs in a fresh project — the error message includes a
    // direct link to auto-create it in the Firebase console.
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, pct: null, sampleSize: 0, error: e.message }) };
  }
};
