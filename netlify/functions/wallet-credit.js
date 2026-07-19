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

  // Two legitimate callers hit this endpoint:
  //  1. A user debiting/crediting their OWN wallet (index.html purchases,
  //     refunds) — here decoded.uid === uid, and the PIN check below is
  //     the real security gate.
  //  2. An admin crediting/debiting ANY user's wallet from admin.html —
  //     here decoded.uid !== uid, so we instead check the admins/{uid}
  //     allowlist, and skip the PIN check since the admin already went
  //     through separate auth and won't know the customer's PIN.
  const isSelfService = decoded.uid === uid;
  let isVerifiedAdmin = false;

  if (!isSelfService) {
    const adminSnap = await db.collection('admins').doc(decoded.uid).get();
    if (!adminSnap.exists) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Not authorized as admin.' })
      };
    }
    isVerifiedAdmin = true;
  }

  const userRef = db.collection('users').doc(uid);

  try {
    let newBalance;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found.');

      const userData = userSnap.data();
      const currentBalance = userData.walletBalance || 0;

      // PIN check — only required for self-service debits. Admin-initiated
      // debits skip this since the admin was already authenticated via the
      // admins/{uid} allowlist above and has no way to know the user's PIN.
      if (delta < 0 && !isVerifiedAdmin) {
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
      } else if (delta < 0 && isVerifiedAdmin) {
        // Still enforce the insufficient-funds check for admin debits —
        // just without requiring a PIN.
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
