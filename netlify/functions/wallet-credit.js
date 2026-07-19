// netlify/functions/wallet-credit.js
// Credits or debits a user's walletBalance in Firestore.
// Uses Firebase Admin SDK so client security rules can't be bypassed.
//
// Body (debit/credit):
//   { idToken, uid, delta, reason, pin? }
//   delta > 0 = credit, delta < 0 = debit
//
// Body (wallet funding via Flutterwave):
//   { idToken, uid, delta, reason, type: 'wallet_funding', paymentRef }
//
// Returns: { ok, newBalance } or { ok: false, error, pinError? }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const crypto = require('crypto');

// Must exactly match the client's hashing scheme in index.html:
//   sha256Hex(`${pin}:${uid}`)  — see _pinHashInput() / submitCreatePin()
// Hashing the PIN alone (without the UID) here was a mismatch that made
// every PIN check fail server-side regardless of what the user entered.
function hashPin(pin, uid) {
  return crypto.createHash('sha256').update(`${pin}:${uid}`).digest('hex');
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

  const { idToken, uid, delta, reason, pin, type, paymentRef } = body;

  if (!idToken || !uid || delta === undefined || delta === null) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  // Verify the Firebase ID token
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' })
    };
  }

  // This endpoint is called by the admin panel to credit/debit ANY user's
  // wallet, so the caller (decoded.uid, the signed-in admin) will almost
  // never equal the target `uid`. Checking decoded.uid !== uid here was a
  // leftover from a self-service pattern and made every admin edit fail
  // with "Token/uid mismatch." What we actually need to verify is that the
  // caller is a real admin, via the same admins/{uid} allowlist the rest
  // of the admin panel relies on.
  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Not authorized as admin.' })
    };
  }

  const userRef = db.collection('users').doc(uid);

  try {
    let newBalance;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found.');

      const userData = userSnap.data();
      const currentBalance = userData.walletBalance || 0;

      // PIN check — only required for debits
      if (delta < 0) {
        const storedHash = userData.pinHash;
        if (storedHash) {
          if (!pin) throw Object.assign(new Error('PIN required.'), { pinError: 'PIN_REQUIRED' });
          if (hashPin(pin, uid) !== storedHash) {
            throw Object.assign(new Error('Incorrect PIN.'), { pinError: 'INVALID_PIN' });
          }
        }
        // Insufficient funds check
        if (currentBalance + delta < 0) {
          throw new Error('Insufficient wallet balance.');
        }
      }

      newBalance = currentBalance + Number(delta);

      const updates = { walletBalance: newBalance };
      tx.update(userRef, updates);

      // Write transaction record for wallet_funding (purchases write their own records)
      if (type === 'wallet_funding' && paymentRef) {
        const txRef = db.collection('transactions').doc();
        tx.set(txRef, {
          userId: uid,
          type: 'wallet_funding',
          amount: Number(delta),
          status: 'success',
          paymentRef: paymentRef || null,
          reason: reason || 'Wallet funding',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, newBalance })
    };
  } catch (e) {
    console.error('wallet-credit error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, pinError: e.pinError || null })
    };
  }
};
