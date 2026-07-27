// netlify/functions/p2p-transfer.js
// Sends wallet balance from one WoodPay user to another, found by their
// registered phone number. Same PIN-verification pattern as wallet-credit.js,
// and the same atomic-transaction approach — the actual balance move only
// ever happens through the Admin SDK, never client-side.
//
// Body:   { idToken, uid, recipientPhone, amount, pin }
// Returns: { ok, newBalance, recipientName } or { ok: false, error, pinError? }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const crypto = require('crypto');

// Must exactly match wallet-credit.js's hashing scheme.
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

  const { idToken, uid, recipientPhone, amount, pin } = body;
  const amt = Number(amount);

  if (!idToken || !uid || !recipientPhone || !(amt > 0)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }
  if (decoded.uid !== uid) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'You can only send from your own wallet.' }) };
  }

  const senderRef = db.collection('users').doc(uid);

  // Recipient lookup is a query, which Firestore transactions can't run
  // directly — do it before the transaction, then pass the resolved doc
  // reference in, so the actual money move is still atomic.
  const cleanPhone = String(recipientPhone).trim();
  const recipientQuery = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
  if (recipientQuery.empty) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'No WoodPay user found with that phone number.' }) };
  }
  const recipientDoc = recipientQuery.docs[0];
  if (recipientDoc.id === uid) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: "You can't send money to yourself." }) };
  }
  const recipientRef = db.collection('users').doc(recipientDoc.id);

  try {
    let newBalance, recipientName;

    await db.runTransaction(async (tx) => {
      const [senderSnap, recipientSnap] = await Promise.all([tx.get(senderRef), tx.get(recipientRef)]);
      if (!senderSnap.exists) throw new Error('Sender account not found.');
      if (!recipientSnap.exists) throw new Error('Recipient account no longer exists.');

      const senderData = senderSnap.data();
      const recipientData = recipientSnap.data();
      recipientName = recipientData.name || recipientData.email || cleanPhone;

      // PIN check — identical rule to wallet-credit.js: required if the
      // sender has set one up, since this is always a self-service debit.
      const storedHash = senderData.pinHash;
      if (storedHash) {
        if (!pin) throw Object.assign(new Error('PIN required.'), { pinError: 'PIN_REQUIRED' });
        if (hashPin(pin, uid) !== storedHash) {
          throw Object.assign(new Error('Incorrect PIN.'), { pinError: 'INVALID_PIN' });
        }
      }

      const senderBalance = senderData.walletBalance || 0;
      if (senderBalance < amt) throw new Error('Insufficient wallet balance.');

      newBalance = senderBalance - amt;
      const recipientNewBalance = (recipientData.walletBalance || 0) + amt;

      tx.update(senderRef, { walletBalance: newBalance });
      tx.update(recipientRef, { walletBalance: recipientNewBalance });

      const senderTxRef = db.collection('transactions').doc();
      tx.set(senderTxRef, {
        userId: uid,
        type: 'p2p_sent',
        amount: -amt,
        status: 'success',
        description: `Sent to ${recipientName} (${cleanPhone})`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const recipientTxRef = db.collection('transactions').doc();
      tx.set(recipientTxRef, {
        userId: recipientDoc.id,
        type: 'p2p_received',
        amount: amt,
        status: 'success',
        description: `Received from ${senderData.name || senderData.email || 'a WoodPay user'}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, newBalance, recipientName }) };
  } catch (e) {
    console.error('p2p-transfer error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, pinError: e.pinError || null })
    };
  }
};
