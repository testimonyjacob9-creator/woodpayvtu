// netlify/functions/wallet-credit.js
// Credits or debits a user's walletBalance in Firestore.
// Uses Firebase Admin SDK so client security rules can't be bypassed.
//
// Body (debit/credit):
//   { idToken, uid, delta, reason, pin? }
//   delta > 0 = credit, delta < 0 = debit
//
// Body (wallet funding via Flutterwave):
//   { idToken, uid, delta, reason, type: 'wallet_funding', paymentRef, transactionId }
//
// Returns: { ok, newBalance } or { ok: false, error, pinError? }
//
// SECURITY FIX (audit finding, see chat): the self-service wallet_funding
// branch used to trust `delta` and `paymentRef` from the request body with
// no server-side check that a real Flutterwave payment had happened —
// idToken verification only proves WHO is calling, not that they paid.
// Any signed-in user could POST here directly (bypassing the UI entirely)
// with an arbitrary delta and a made-up paymentRef and mint free wallet
// balance. This is now closed two ways for that branch specifically:
//   1. The charge is independently re-verified against Flutterwave's
//      /transactions/:id/verify endpoint (same call verify-payment.js
//      makes) — status, amount and tx_ref must all match what's claimed.
//   2. The funding transaction is written under a deterministic doc ID
//      derived from paymentRef, and checked for existence inside the same
//      Firestore transaction that credits the balance — so replaying a
//      real, previously-verified paymentRef a second time is rejected
//      instead of crediting twice.
// Admin-initiated credits/debits (isVerifiedAdmin) and self-service debits
// (PIN-gated) are unchanged.
const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const crypto = require('crypto');
const { notifyUser } = require('./_notify');

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';

// Must exactly match the client's hashing scheme in index.html:
//   sha256Hex(`${pin}:${uid}`)  — see _pinHashInput() / submitCreatePin()
// Hashing the PIN alone (without the UID) here was a mismatch that made
// every PIN check fail server-side regardless of what the user entered.
function hashPin(pin, uid) {
  return crypto.createHash('sha256').update(`${pin}:${uid}`).digest('hex');
}

// Re-verifies a card charge directly with Flutterwave — mirrors
// verify-payment.js's logic so wallet-credit never has to trust the
// client's word that a payment succeeded.
async function verifyFlutterwaveCharge(transactionId, expectedAmount, expectedTxRef) {
  if (!FLW_SECRET_KEY) return { ok: false, error: 'Payment verification not configured. Contact support.' };
  try {
    const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` }
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') return { ok: false, error: data.message || 'Verification failed' };
    const tx = data.data;
    if (expectedAmount && Math.abs(tx.amount - Number(expectedAmount)) > 1) return { ok: false, error: 'Amount mismatch — possible fraud attempt.' };
    if (expectedTxRef && tx.tx_ref !== expectedTxRef) return { ok: false, error: 'Transaction reference mismatch.' };
    if (tx.status !== 'successful') return { ok: false, error: `Payment status: ${tx.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Could not reach verification server. Contact support if you were charged.' };
  }
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

  const { idToken, uid, delta, reason, pin, type, paymentRef, transactionId } = body;

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

  // Self-service wallet funding via card: independently confirm the charge
  // with Flutterwave before touching any balance. See the SECURITY note
  // at the top of this file.
  let fundingDocId = null;
  if (isSelfService && type === 'wallet_funding') {
    if (!paymentRef || !transactionId) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing payment reference.' }) };
    }
    const verify = await verifyFlutterwaveCharge(transactionId, delta, paymentRef);
    if (!verify.ok) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: verify.error }) };
    }
    // Deterministic ID from the verified paymentRef, so a replay of the
    // same real payment lands on the same doc instead of a new one.
    const safeRef = String(paymentRef).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
    fundingDocId = `wfund_${safeRef}`;
  }

  const userRef = db.collection('users').doc(uid);

  try {
    let newBalance;

    await db.runTransaction(async (tx) => {
      // Idempotency check — must run before any writes in this transaction.
      if (fundingDocId) {
        const existing = await tx.get(db.collection('transactions').doc(fundingDocId));
        if (existing.exists) {
          throw Object.assign(new Error('This payment has already been credited to your wallet.'), { alreadyCredited: true });
        }
      }

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

      // Write a transaction record so the balance change actually shows up
      // in the user's history — not just a silently different number.
      // Self-service wallet funding (Flutterwave) gets its own record here,
      // at the deterministic ID computed above once verified; any other
      // admin-initiated edit (plain credit/debit from admin.html's
      // editWallet, which sends no type/paymentRef) needs one too, since
      // index.html's txLabel() already renders admin_credit/admin_debit as
      // "From WoodPay" — it was just never being written.
      if (type === 'wallet_funding' && fundingDocId) {
        const txRef = db.collection('transactions').doc(fundingDocId);
        tx.set(txRef, {
          userId: uid,
          type: 'wallet_funding',
          amount: Number(delta),
          status: 'success',
          paymentRef: paymentRef || null,
          flwTransactionId: transactionId || null,
          reason: reason || 'Wallet funding',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else if (isVerifiedAdmin) {
        const txRef = db.collection('transactions').doc();
        tx.set(txRef, {
          userId: uid,
          type: delta >= 0 ? 'admin_credit' : 'admin_debit',
          amount: Number(delta),
          status: 'success',
          description: reason || 'From WoodPay',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    if (isVerifiedAdmin) {
      const isCredit = delta >= 0;
      await notifyUser(admin, db, uid, {
        title: isCredit ? 'Wallet credited ✅' : 'Wallet debited',
        body: `₦${Math.abs(Number(delta))} was ${isCredit ? 'added to' : 'removed from'} your wallet by WoodPay. ${reason ? 'Reason: ' + reason : ''}`.trim(),
        type: isCredit ? 'success' : 'warning',
        url: '/',
        from: 'admin'
      });
    }

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
      body: JSON.stringify({ ok: false, error: e.message, pinError: e.pinError || null, alreadyCredited: e.alreadyCredited || false })
    };
  }
};
