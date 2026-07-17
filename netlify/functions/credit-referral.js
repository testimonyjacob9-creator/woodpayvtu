// netlify/functions/credit-referral.js
// Credits the referral bonus to a referrer's wallet.
// Re-verifies the qualifying transaction server-side and stamps it so it
// can't be double-paid on retry.
//
// Body: { idToken, uid, txId }
// Returns: { ok } or { ok: false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const REFERRAL_BONUS = 50;          // ₦50 per qualifying transaction
const MIN_TX_AMOUNT = 1000;         // transaction must be >= ₦1,000 to qualify

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

  const { idToken, uid, txId } = body;

  if (!idToken || !uid || !txId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
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
    // Get the transaction and the buyer's profile in parallel
    const [txSnap, buyerSnap] = await Promise.all([
      db.collection('transactions').doc(txId).get(),
      db.collection('users').doc(uid).get()
    ]);

    if (!txSnap.exists) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Transaction not found.' })
      };
    }

    const tx = txSnap.data();

    // Ownership check
    if (tx.userId !== uid) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Not your transaction.' })
      };
    }

    // Already stamped — idempotent exit
    if (tx.referralPaid) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, skipped: true })
      };
    }

    // Must be a successful purchase of sufficient amount
    if (tx.status !== 'success' || (tx.amount || 0) < MIN_TX_AMOUNT) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Transaction does not qualify for referral bonus.' })
      };
    }

    const buyer = buyerSnap.exists ? buyerSnap.data() : {};
    const referralCode = buyer.referredBy;

    if (!referralCode) {
      // Buyer was not referred — nothing to do
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, skipped: true })
      };
    }

    // Find the referrer by their referral code
    const referrerQuery = await db.collection('users')
      .where('referralCode', '==', referralCode)
      .limit(1)
      .get();

    if (referrerQuery.empty) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Referrer not found.' })
      };
    }

    const referrerDoc = referrerQuery.docs[0];
    const referrerRef = referrerDoc.ref;

    // Atomic: stamp the transaction + credit the referrer
    await db.runTransaction(async (txn) => {
      const referrerSnap = await txn.get(referrerRef);
      const referrerData = referrerSnap.data();
      const currentBalance = referrerData.walletBalance || 0;
      const currentEarnings = referrerData.referralEarnings || 0;

      txn.update(referrerRef, {
        walletBalance: currentBalance + REFERRAL_BONUS,
        referralEarnings: currentEarnings + REFERRAL_BONUS
      });

      // Stamp transaction so it can't be double-paid
      txn.update(db.collection('transactions').doc(txId), {
        referralPaid: true,
        referralPaidAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Log the bonus credit
      const bonusRef = db.collection('transactions').doc();
      txn.set(bonusRef, {
        userId: referrerDoc.id,
        type: 'referral_bonus',
        amount: REFERRAL_BONUS,
        status: 'success',
        reason: `Referral bonus for tx ${txId}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, bonus: REFERRAL_BONUS })
    };
  } catch (e) {
    console.error('credit-referral error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};
