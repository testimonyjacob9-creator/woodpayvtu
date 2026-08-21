// netlify/functions/admin-approve-withdrawal.js
//
// Admin-only. Called from admin.html's Withdrawals tab after the admin has
// manually paid a user's bank account (via the Flutterwave dashboard or
// any bank app) for a pending withdrawal created by withdraw-request.js.
//
//   action 'approve': marks the withdrawal + its transaction record
//                      'success' and notifies the user it's been paid.
//   action 'reject':  marks both 'rejected' and REFUNDS the reserved
//                      amount back to the user's wallet (e.g. bad account
//                      details, suspected fraud) — the debit made at
//                      request time is reversed, not left stuck.
//
// Body: { idToken, withdrawalId, action, note? }
// Returns: { ok } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const { idToken, withdrawalId, action, note } = body;
  if (!idToken || !withdrawalId || !['approve', 'reject'].includes(action)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing or invalid required fields' }) };
  }

  const db = admin.firestore();

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }

  const adminSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!adminSnap.exists) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Not authorized as admin.' }) };
  }

  const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);

  try {
    let notifyPayload = null;

    await db.runTransaction(async (tx) => {
      const wSnap = await tx.get(withdrawalRef);
      if (!wSnap.exists) throw new Error('Withdrawal not found.');
      const w = wSnap.data();
      if (w.status !== 'pending') {
        throw new Error(`This withdrawal was already ${w.status}.`);
      }

      // Find the matching transaction doc. Written with a withdrawalId
      // field pointing back at this withdrawal, so this is a simple
      // targeted query instead of trusting a client-supplied tx id.
      const txQuery = await tx.get(
        db.collection('transactions').where('withdrawalId', '==', withdrawalId).limit(1)
      );

      if (action === 'approve') {
        tx.update(withdrawalRef, {
          status: 'success',
          approvedBy: decoded.uid,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
          note: note || null
        });
        txQuery.forEach((doc) => tx.update(doc.ref, { status: 'success' }));
        notifyPayload = {
          title: 'Withdrawal paid ✅',
          body: `₦${w.amount} has been sent to your ${w.bankName} account (${w.accountNumber}).`,
          type: 'success'
        };
      } else {
        // Reject — refund the reserved amount back to the wallet.
        const userRef = db.collection('users').doc(w.userId);
        const userSnap = await tx.get(userRef);
        if (userSnap.exists) {
          const currentBalance = userSnap.data().walletBalance || 0;
          tx.update(userRef, { walletBalance: currentBalance + w.amount });
        }
        tx.update(withdrawalRef, {
          status: 'rejected',
          rejectedBy: decoded.uid,
          rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
          note: note || null
        });
        txQuery.forEach((doc) => tx.update(doc.ref, { status: 'failed' }));
        notifyPayload = {
          title: 'Withdrawal declined',
          body: `Your ₦${w.amount} withdrawal request was declined${note ? ': ' + note : '.'} The amount has been refunded to your wallet.`,
          type: 'warning'
        };
      }

      // Stash uid on the outer scope var via closure — Firestore
      // transactions must finish all reads before writes, so this is
      // computed here but the notification is sent after commit below.
      notifyPayload.uid = w.userId;
    });

    if (notifyPayload) {
      await notifyUser(admin, db, notifyPayload.uid, {
        title: notifyPayload.title,
        body: notifyPayload.body,
        type: notifyPayload.type,
        url: '/',
        from: 'admin'
      });
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('admin-approve-withdrawal error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
