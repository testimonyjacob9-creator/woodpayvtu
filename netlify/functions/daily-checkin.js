// netlify/functions/daily-checkin.js
// "Spin & Win" daily reward. One claim per calendar day (Africa/Lagos, UTC+1,
// fixed offset — no DST in Nigeria so this is safe year-round). Reward amount
// is picked server-side from a weighted table so it can never be tampered
// with from the client.
//
// Body:   { idToken, uid }
// Returns: { ok, reward, newBalance } or { ok: false, error, alreadyClaimed? }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

// Weighted so small rewards are common and the big one is a rare, exciting hit.
const REWARD_TABLE = [
  { amount: 10, weight: 35 },
  { amount: 20, weight: 30 },
  { amount: 30, weight: 18 },
  { amount: 50, weight: 12 },
  { amount: 100, weight: 5 }
];

function pickReward() {
  const total = REWARD_TABLE.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of REWARD_TABLE) {
    if (roll < r.weight) return r.amount;
    roll -= r.weight;
  }
  return REWARD_TABLE[0].amount;
}

// Nigeria is UTC+1 year-round (no DST) — offsetting before taking the date
// string means the "day" boundary matches local midnight, not UTC midnight.
function lagosDateString(d = new Date()) {
  const lagos = new Date(d.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10); // YYYY-MM-DD
}

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

  const { idToken, uid } = body;
  if (!idToken || !uid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }
  if (decoded.uid !== uid) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'You can only claim your own reward.' }) };
  }

  const userRef = db.collection('users').doc(uid);
  const today = lagosDateString();

  try {
    let reward, newBalance;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found.');
      const data = snap.data();

      if (data.lastCheckIn === today) {
        throw Object.assign(new Error('Already claimed today — come back tomorrow!'), { alreadyClaimed: true });
      }

      reward = pickReward();
      newBalance = (data.walletBalance || 0) + reward;

      tx.update(userRef, { walletBalance: newBalance, lastCheckIn: today });

      const txRef = db.collection('transactions').doc();
      tx.set(txRef, {
        userId: uid,
        type: 'checkin_reward',
        amount: reward,
        status: 'success',
        description: 'Daily Spin & Win reward',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, reward, newBalance }) };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, alreadyClaimed: e.alreadyClaimed || false })
    };
  }
};
