// netlify/functions/flw-v3-webhook.js
//
// Receives Flutterwave v3 "charge.completed" webhooks for the Wema
// virtual accounts created in create-virtual-account.js (dynamic) and
// create-permanent-account.js (static), and credits the matching user's
// wallet once a transfer is confirmed. Replaces flw-v4-webhook.js.
//
// IMPORTANT — before this goes live:
// 1. In your Flutterwave dashboard: Settings > Webhooks, set this
//    function's URL as your webhook URL, e.g.
//    https://woodpayvtu.netlify.app/.netlify/functions/flw-v3-webhook
// 2. Set a Secret Hash there — any long random string you choose.
// 3. Add that exact string as FLW_WEBHOOK_SECRET_HASH in Netlify env
//    vars. (Unlike v4, v3 does NOT HMAC-sign the payload — it just sends
//    your secret hash back verbatim in a `verif-hash` header, which we
//    directly string-compare, timing-safe, against our own copy.)
//
// Confirmed against Flutterwave's live v3 docs (Aug 2026) — a transfer
// into a virtual account fires this shape:
//   {
//     "event": "charge.completed",
//     "data": {
//       "id": 2028146660,          // numeric charge id — unique per charge, never reused
//       "tx_ref": "...",           // the reference we set at account creation
//       "flw_ref": "...",
//       "amount": 100,             // amount received
//       "currency": "NGN",
//       "charged_amount": 102,
//       "app_fee": 2,
//       "status": "successful",    // note: lowercase "successful", NOT v4's "succeeded"
//       "payment_type": "bank_transfer",
//       "customer": { id, name, phone_number, email, created_at } // the SENDER, not us
//     },
//     "meta_data": { originatorname, bankname, bankcode, originatoramount, originatoraccountnumber },
//     "event.type": "BANK_TRANSFER_TRANSACTION"
//   }
//
// Same limitation as v4: there is NO destination/receiving account number
// anywhere in this payload, and `customer` is the sender's Flutterwave
// customer record, not the WoodPay user who got paid. So for a static
// account, the only reliable match is `data.tx_ref` against
// permanentAccount.reference — see handlePossibleStaticAccountTransfer().

const crypto = require('crypto');
const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');
const { sendAdminFailureAlert } = require('./_adminAlert');

const FLW_WEBHOOK_SECRET_HASH = process.env.FLW_WEBHOOK_SECRET_HASH || '';

// Must match FEE_RATE in create-virtual-account.js / create-permanent-account.js.
// For dynamic accounts the customer pays amount+fee upfront (fee added on).
// For a static/permanent account there's no "requested amount" ahead of
// time — whatever lands, we deduct our fee from it and credit the rest.
const FEE_RATE = 0.0215;

// destinationAccountNumber isn't sent by v3 either (confirmed above), but
// this is kept as a defensive best-effort fallback in case Flutterwave
// ever adds one of these fields for some payload variant — same posture
// as the old v4 webhook.
function extractDestinationAccountNumber(data) {
  const candidates = [
    data.virtual_account && data.virtual_account.account_number,
    data.payment_method && data.payment_method.virtual_account && data.payment_method.virtual_account.account_number,
    data.account_number,
    data.meta && data.meta.account_number
  ];
  return candidates.find(v => typeof v === 'string' && v.length > 0) || null;
}

async function handlePossibleStaticAccountTransfer(db, payload, data, reference, status, amount, chargeId) {
  if (status !== 'successful') {
    console.warn('flw-v3-webhook: no matching pending transaction and status is not successful', { reference, status });
    return { statusCode: 200, body: 'No matching transaction' };
  }

  const destinationAccountNumber = extractDestinationAccountNumber(data);

  // Primary match: the reused static-account creation reference (tx_ref).
  let userQuery = await db.collection('users')
    .where('permanentAccount.reference', '==', reference)
    .limit(1)
    .get();

  // Fallback: destination account number, in case Flutterwave ever starts
  // sending it for some payload variant.
  if (userQuery.empty && destinationAccountNumber) {
    userQuery = await db.collection('users')
      .where('permanentAccount.accountNumber', '==', destinationAccountNumber)
      .limit(1)
      .get();
  }

  if (userQuery.empty) {
    console.warn('flw-v3-webhook: no user found for reference / destination account', { reference, destinationAccountNumber, fullPayload: JSON.stringify(data) });
    return { statusCode: 200, body: 'No matching user for static transfer' };
  }

  const userDoc = userQuery.docs[0];
  const uid = userDoc.id;

  if (!userDoc.data().permanentAccount) {
    console.warn('flw-v3-webhook: customer matched but has no permanent account on file', uid);
    return { statusCode: 200, body: 'User has no permanent account' };
  }

  // Idempotency — webhooks can be delivered more than once for the same charge.
  //
  // IMPORTANT: we key this off the charge id (data.id), NOT `reference` —
  // for static accounts, Flutterwave reuses the exact same tx_ref across
  // every charge into that account, so matching on reference here would
  // treat every top-up after the first as a duplicate and silently skip
  // crediting it.
  if (!chargeId) {
    console.warn('flw-v3-webhook: static transfer has no charge id — cannot safely dedupe, proceeding once', { reference });
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
    console.warn('flw-v3-webhook: static transfer amount too small to cover fee', { amount, fee, uid });
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

function isValidSignature(signatureHeader) {
  if (!FLW_WEBHOOK_SECRET_HASH || !signatureHeader) return false;
  // v3 sends the secret hash back verbatim (not HMAC-signed like v4) — a
  // direct, timing-safe string compare is all that's needed/expected.
  const expected = Buffer.from(FLW_WEBHOOK_SECRET_HASH);
  const got = Buffer.from(String(signatureHeader));
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(expected, got);
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    console.error('flw-v3-webhook: admin init error', ADMIN_INIT_ERROR);
    return { statusCode: 500, body: 'Server misconfigured' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody = event.body || '';
  const signature = event.headers['verif-hash'] || event.headers['Verif-Hash'] || '';

  if (!isValidSignature(signature)) {
    console.warn('flw-v3-webhook: invalid signature — rejecting');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  // Always return 200 quickly once we've validated the signature, even if
  // the event type isn't one we act on — Flutterwave will retry on
  // non-2xx responses, and we don't want retries for events we intentionally ignore.
  if (payload.event !== 'charge.completed') {
    return { statusCode: 200, body: 'Ignored — not a charge.completed event' };
  }

  const data = payload.data || {};

  // Only virtual-account bank transfers should ever hit this endpoint
  // (that's all WoodPay creates), but charge.completed also fires for
  // other payment types on the account — ignore anything that isn't a
  // bank transfer rather than risk mis-processing it here.
  if (data.payment_type && data.payment_type !== 'bank_transfer') {
    return { statusCode: 200, body: 'Ignored — not a bank_transfer charge' };
  }

  const reference = data.tx_ref;
  const chargeId = data.id; // unique per charge — unlike tx_ref, never reused
  const status = data.status; // expect "successful"
  const amount = Number(data.amount || 0);

  if (!reference) {
    console.warn('flw-v3-webhook: no tx_ref in payload', data);
    return { statusCode: 200, body: 'No reference — ignored' };
  }

  const db = admin.firestore();

  try {
    // Find the matching pending transaction we created in create-virtual-account.js
    const txQuery = await db.collection('transactions')
      .where('reference', '==', reference)
      .where('type', '==', 'wallet_funding_dynamic')
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
    // Anything else (pending, or a status we don't recognize yet) is left
    // as 'pending' so a later 'successful' webhook can still credit the
    // wallet normally, instead of the transaction being permanently marked
    // failed before the real outcome is known.
    const TERMINAL_FAILURE_STATUSES = ['failed', 'cancelled', 'expired'];

    if (status !== 'successful') {
      if (TERMINAL_FAILURE_STATUSES.includes(status)) {
        await txDoc.ref.update({ status: 'failed', flwStatus: status, reason: `Wallet funding declined by Flutterwave (status: ${status})` });
        await notifyUser(admin, db, txData.userId, {
          title: 'Wallet funding failed',
          body: `Your funding of ₦${txData.amount} did not go through. If money left your account, contact support.`,
          type: 'danger',
          url: '/'
        });
        sendAdminFailureAlert({
          source: 'Wallet funding webhook (flw-v3-webhook.js)',
          txType: 'wallet_funding_dynamic',
          amount: txData.amount,
          ref: reference,
          reason: `Flutterwave status: ${status}`,
          userEmail: txData.userEmail || '',
          uid: txData.userId
        }).catch(() => {});
        return { statusCode: 200, body: 'Recorded terminal failure status' };
      }
      // Non-terminal status — log it but leave the transaction pending.
      console.log('flw-v3-webhook: non-terminal status received, leaving pending:', status, reference);
      return { statusCode: 200, body: 'Non-terminal status — left pending' };
    }

    // Verify amount matches what we expected before crediting anything.
    // Compare against chargeAmount (amount + fee) since that's what the
    // customer actually transferred — the wallet itself is still only
    // credited txData.amount, the original requested top-up.
    const expectedAmount = txData.chargeAmount || txData.amount;
    if (Math.abs(amount - Number(expectedAmount)) > 1) {
      console.error('flw-v3-webhook: amount mismatch', { expected: expectedAmount, got: amount, reference });
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
      tx.update(userRef, { walletBalance: newBalance, lastActivityAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(txDoc.ref, { status: 'success', chargeId: chargeId || null, creditedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    await notifyUser(admin, db, uid, {
      title: 'Wallet funded ✅',
      body: `₦${txData.amount} was added to your wallet.`,
      type: 'success',
      url: '/'
    });

    return { statusCode: 200, body: 'Wallet credited' };
  } catch (e) {
    console.error('flw-v3-webhook error:', e.message);
    // Return 200 anyway after logging — returning 5xx here just causes
    // Flutterwave to retry the same webhook, which won't fix a bug in our
    // own code and could double-process once the bug is fixed. Investigate
    // via logs instead.
    return { statusCode: 200, body: 'Error logged' };
  }
};
