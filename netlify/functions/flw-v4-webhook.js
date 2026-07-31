// netlify/functions/flw-v4-webhook.js
//
// Receives Flutterwave v4 "charge.completed" webhooks for the Sterling
// dynamic virtual accounts created in create-virtual-account.js, and
// credits the matching user's wallet once a transfer is confirmed.
//
// IMPORTANT — before this goes live:
// 1. In your Flutterwave dashboard: Settings > Webhooks, set this
//    function's URL as your webhook URL, e.g.
//    https://woodpay.netlify.app/.netlify/functions/flw-v4-webhook
// 2. Set a Secret Hash there (any long random string you choose).
// 3. Add that exact string as FLW_WEBHOOK_SECRET_HASH in Netlify env vars.
// v4 signs webhooks differently from v3: instead of sending your secret
// hash back verbatim in a "verif-hash" header, it HMAC-SHA256-signs the
// raw request body using your secret hash, and sends the result (base64)
// in a "flutterwave-signature" header. We must recompute that hash here
// and compare — never trust the payload without this check, since this
// URL is publicly reachable by anyone.

const crypto = require('crypto');
const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');

const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH || '';

// Must match FEE_RATE in create-virtual-account.js / create-permanent-account.js.
// For dynamic accounts the customer pays amount+fee upfront (fee added on).
// For a static/permanent account there's no "requested amount" ahead of
// time — whatever lands, we deduct our fee from it and credit the rest.
const FEE_RATE = 0.0215;

// Handles a transfer into a user's permanent (static) virtual account —
// i.e. one that wasn't a match for any pending dynamic-account transaction.
//
// IMPORTANT: for a bank transfer, the `customer` object in the webhook is
// the SENDER's Flutterwave customer record (whoever transferred the
// money), NOT the receiving WoodPay user, and `payment_method.bank_transfer`
// only carries the sender's (originator) bank name/account/name — v4 does
// NOT send a destination/receiving account number anywhere in this
// payload (confirmed from a live webhook). So neither of those can be used
// to identify which of our users got paid.
//
// What IS reliable: `data.reference`. Flutterwave reuses the exact same
// reference that was sent when the static account was created for every
// subsequent charge into that account. So we match by looking up
// permanentAccount.reference — this is the primary and only real match
// for a static bank transfer.
//
// destinationAccountNumber / customerId are kept as a best-effort fallback
// only, in case Flutterwave ever adds one of these fields for some payload
// variant — they should not be relied on.
function extractDestinationAccountNumber(data) {
  const candidates = [
    data.virtual_account && data.virtual_account.account_number,
    data.payment_method && data.payment_method.virtual_account && data.payment_method.virtual_account.account_number,
    data.payment_method && data.payment_method.bank_transfer && data.payment_method.bank_transfer.account_number,
    data.payment_method && data.payment_method.bank_transfer && data.payment_method.bank_transfer.virtual_account && data.payment_method.bank_transfer.virtual_account.account_number,
    data.account_number,
    data.meta && data.meta.account_number
  ];
  return candidates.find(v => typeof v === 'string' && v.length > 0) || null;
}

async function handlePossibleStaticAccountTransfer(db, payload, data, reference, status, amount, chargeId) {
  if (status !== 'succeeded') {
    console.warn('flw-v4-webhook: no matching pending transaction and status is not succeeded', { reference, status });
    return { statusCode: 200, body: 'No matching transaction' };
  }

  const destinationAccountNumber = extractDestinationAccountNumber(data);
  const customerId = data.customer || data.customer_id || (data.customer && data.customer.id) || null;

  // Primary match: the reused static-account creation reference.
  let userQuery = await db.collection('users')
    .where('permanentAccount.reference', '==', reference)
    .limit(1)
    .get();

  // Fallback 1: destination account number, in case Flutterwave ever
  // starts sending it for some payload variant.
  if (userQuery.empty && destinationAccountNumber) {
    userQuery = await db.collection('users')
      .where('permanentAccount.accountNumber', '==', destinationAccountNumber)
      .limit(1)
      .get();
  }

  // Fallback 2: customer id, in case Flutterwave ever does echo the
  // merchant-side customer for this flow.
  if (userQuery.empty && customerId) {
    userQuery = await db.collection('users')
      .where('flwCustomerId', '==', customerId)
      .limit(1)
      .get();
  }

  if (userQuery.empty) {
    console.warn('flw-v4-webhook: no user found for reference / destination account / customer id', { reference, destinationAccountNumber, customerId, fullPayload: JSON.stringify(data) });
    return { statusCode: 200, body: 'No matching user for static transfer' };
  }

  const userDoc = userQuery.docs[0];
  const uid = userDoc.id;

  if (!userDoc.data().permanentAccount) {
    console.warn('flw-v4-webhook: customer matched but has no permanent account on file', uid);
    return { statusCode: 200, body: 'User has no permanent account' };
  }

  // Idempotency — webhooks can be delivered more than once for the same charge.
  //
  // IMPORTANT: we key this off the charge id (data.id, e.g. "chg_..."),
  // NOT `reference` — for static accounts, Flutterwave reuses the exact
  // same reference across every charge into that account, so matching on
  // reference here would treat every top-up after the first as a
  // duplicate and silently skip crediting it.
  if (!chargeId) {
    console.warn('flw-v4-webhook: static transfer has no charge id — cannot safely dedupe, proceeding once', { reference });
  } else {
    const existing = await db.collection('transactions')
      .where('chargeId', '==', chargeId)
      .where('type', '==', 'wallet_funding_static')
      .limit(1)
      .get();
    if (!existing.empty) {
      return { statusCode: 200, body: 'Already processed (static)' };
    }
  }

  const fee = Math.round(amount * FEE_RATE);
  const netCredit = amount - fee;
  if (netCredit <= 0) {
    console.warn('flw-v4-webhook: static transfer amount too small to cover fee', { amount, fee, uid });
    return { statusCode: 200, body: 'Amount too small — not credited' };
  }

  const userRef = db.collection('users').doc(uid);
  const txRef = db.collection('transactions').doc();

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error('User not found for static wallet credit.');
    const currentBalance = userSnap.data().walletBalance || 0;
    tx.update(userRef, { walletBalance: currentBalance + netCredit });
    tx.set(txRef, {
      userId: uid,
      type: 'wallet_funding_static',
      amount: netCredit,
      grossAmount: amount,
      fee,
      status: 'success',
      reference,
      chargeId: chargeId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      creditedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  await notifyUser(admin, db, uid, {
    title: 'Wallet funded ✅',
    body: `₦${netCredit} was added to your wallet (₦${amount} received, ₦${fee} fee deducted).`,
    type: 'success',
    url: '/'
  });

  return { statusCode: 200, body: 'Static account wallet credited' };
}

function isValidSignature(rawBody, signatureHeader) {
  if (!FLW_WEBHOOK_SECRET_HASH || !signatureHeader) return false;
  const computed = crypto
    .createHmac('sha256', FLW_WEBHOOK_SECRET_HASH)
    .update(rawBody)
    .digest('base64');
  // Timing-safe compare
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signatureHeader));
  } catch (e) {
    return false; // length mismatch etc — definitely not a match
  }
}

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    console.error('flw-v4-webhook: admin init error', ADMIN_INIT_ERROR);
    return { statusCode: 500, body: 'Server misconfigured' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';
  const signature = event.headers['flutterwave-signature'] || event.headers['Flutterwave-Signature'] || '';

  if (!isValidSignature(rawBody, signature)) {
    console.warn('flw-v4-webhook: invalid signature — rejecting');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  // Always return 200 quickly once we've validated the signature, even if
  // the event type isn't one we act on — Flutterwave will retry on
  // non-2xx responses, and we don't want retries for events we intentionally ignore.
  if (payload.type !== 'charge.completed') {
    return { statusCode: 200, body: 'Ignored — not a charge.completed event' };
  }

  const data = payload.data || {};
  const reference = data.reference;
  const chargeId = data.id; // unique per charge, e.g. "chg_..." — unlike reference, never reused
  const status = data.status; // expect "succeeded"
  const amount = Number(data.amount || 0);

  if (!reference) {
    console.warn('flw-v4-webhook: no reference in payload', data);
    return { statusCode: 200, body: 'No reference — ignored' };
  }

  const db = admin.firestore();

  try {
    // Find the matching pending transaction we created in create-virtual-account.js
    const txQuery = await db.collection('transactions')
      .where('reference', '==', reference)
      .where('type', '==', 'wallet_funding_v4')
      .limit(1)
      .get();

    if (txQuery.empty) {
      return await handlePossibleStaticAccountTransfer(db, payload, data, reference, status, amount, chargeId);
    }

    const txDoc = txQuery.docs[0];
    const txData = txDoc.data();

    if (txData.status !== 'pending') {
      // Already processed — webhooks can be delivered more than once.
      return { statusCode: 200, body: 'Already processed' };
    }

    // Flutterwave can send more than one webhook call for the same charge —
    // e.g. an intermediate status before the final one. Only treat it as a
    // real failure if the status is an explicit terminal-failure value.
    // Anything else (pending, processing, or a status we don't recognize
    // yet) is left as 'pending' so a later 'succeeded' webhook can still
    // credit the wallet normally, instead of the transaction being
    // permanently marked failed before the real outcome is known.
    const TERMINAL_FAILURE_STATUSES = ['failed', 'cancelled', 'expired', 'declined'];

    if (status !== 'succeeded') {
      if (TERMINAL_FAILURE_STATUSES.includes(status)) {
        await txDoc.ref.update({ status: 'failed', flwStatus: status });
        await notifyUser(admin, db, txData.userId, {
          title: 'Wallet funding failed',
          body: `Your funding of ₦${txData.amount} did not go through. If money left your account, contact support.`,
          type: 'danger',
          url: '/'
        });
        return { statusCode: 200, body: 'Recorded terminal failure status' };
      }
      // Non-terminal status — log it but leave the transaction pending.
      console.log('flw-v4-webhook: non-terminal status received, leaving pending:', status, reference);
      return { statusCode: 200, body: 'Non-terminal status — left pending' };
    }

    // Verify amount matches what we expected before crediting anything.
    // Compare against chargeAmount (amount + fee) since that's what the
    // customer actually transferred — the wallet itself is still only
    // credited txData.amount, the original requested top-up.
    const expectedAmount = txData.chargeAmount || txData.amount; // fallback for any older pending tx created before chargeAmount existed
    if (Math.abs(amount - Number(expectedAmount)) > 1) {
      console.error('flw-v4-webhook: amount mismatch', { expected: expectedAmount, got: amount, reference });
      await txDoc.ref.update({ status: 'amount_mismatch', flwAmount: amount });
      return { statusCode: 200, body: 'Amount mismatch — not credited' };
    }

    const uid = txData.userId;
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found for wallet credit.');
      const currentBalance = userSnap.data().walletBalance || 0;
      const newBalance = currentBalance + Number(txData.amount);
      tx.update(userRef, { walletBalance: newBalance });
      tx.update(txDoc.ref, { status: 'success', creditedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    await notifyUser(admin, db, uid, {
      title: 'Wallet funded ✅',
      body: `₦${txData.amount} was added to your wallet.`,
      type: 'success',
      url: '/'
    });

    return { statusCode: 200, body: 'Wallet credited' };
  } catch (e) {
    console.error('flw-v4-webhook error:', e.message);
    // Return 200 anyway after logging — returning 5xx here just causes
    // Flutterwave to retry the same webhook, which won't fix a bug in our
    // own code and could double-process once the bug is fixed. Investigate
    // via logs instead.
    return { statusCode: 200, body: 'Error logged' };
  }
};
