// netlify/functions/create-virtual-account.js
//
// Creates a Flutterwave v4 DYNAMIC virtual account on Sterling Bank
// (bank_code "232") for a single wallet-funding request.
//
// Why dynamic, not static: v4 static (reusable) virtual accounts require
// the customer's BVN or NIN at creation time — WoodPay doesn't currently
// collect that from users, and asking 140 existing users for it would be
// its own friction problem. Dynamic accounts only need name + email, no
// BVN/NIN, and expire after a set window — which also fits the existing
// flow better (one virtual account per funding attempt, same as the old
// per-transaction v3 checkout).
//
// Body:  { idToken, uid, amount }
// Returns: { ok, accountNumber, bankName, reference, expiresAt } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { getFlwV4Token } = require('./_flwV4Auth');

const FLW_V4_BASE = 'https://f4bexperience.flutterwave.com'; // v4 production base URL — different from v3's api.flutterwave.com
const STERLING_BANK_CODE = '232';
const EXPIRY_SECONDS = 1800; // 30 minutes — long enough to complete a transfer, short enough not to leave stale accounts lying around

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

  const { idToken, uid, amount } = body;

  if (!idToken || !uid || !amount || Number(amount) <= 0) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }

  const db = admin.firestore();

  // Verify the Firebase ID token — same pattern as wallet-credit.js
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }
  if (decoded.uid !== uid) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Token/uid mismatch.' }) };
  }

  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'User not found.' }) };
    }
    const userData = userSnap.data();
    const email = userData.email || decoded.email;
    const name = userData.name || 'WoodPayVTU Customer';
    const [first, ...rest] = String(name).trim().split(' ');
    const last = rest.join(' ') || first;

    const token = await getFlwV4Token();

    // 1) Get or create a Flutterwave v4 customer for this user.
    // We cache the customer_id on the user doc so repeat funding requests
    // don't create duplicate customer records with Flutterwave.
    let customerId = userData.flwCustomerId || null;

    if (!customerId) {
      const custRes = await fetch(`${FLW_V4_BASE}/customers`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': `cust-${uid}`
        },
        body: JSON.stringify({
          name: { first: first || 'WoodPay', last: last || 'Customer' },
          email
        })
      });
      const custData = await custRes.json();
      if (!custRes.ok || !custData.data || !custData.data.id) {
        console.error('flw v4 customer create error:', custData);
        return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Could not create payment customer.' }) };
      }
      customerId = custData.data.id;
      await db.collection('users').doc(uid).update({ flwCustomerId: customerId });
    }

    // 2) Create the dynamic virtual account for this specific amount.
    const reference = `WPVA${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    const vaRes = await fetch(`${FLW_V4_BASE}/virtual-accounts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': reference
      },
      body: JSON.stringify({
        reference,
        customer_id: customerId,
        expiry: EXPIRY_SECONDS,
        amount: Number(amount),
        currency: 'NGN',
        account_type: 'dynamic',
        narration: name,
        bank_code: STERLING_BANK_CODE
      })
    });
    const vaData = await vaRes.json();

    if (!vaRes.ok || !vaData.data || !vaData.data.account_number) {
      console.error('flw v4 virtual account create error:', vaData);
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: vaData.message || 'Could not generate virtual account.' }) };
    }

    // 3) Record a pending funding transaction so the webhook has something
    // to match against and credit once the transfer lands.
    await db.collection('transactions').doc().set({
      userId: uid,
      type: 'wallet_funding_v4',
      amount: Number(amount),
      status: 'pending',
      reference,
      virtualAccountId: vaData.data.id,
      accountNumber: vaData.data.account_number,
      bankName: vaData.data.account_bank_name,
      note: vaData.data.note || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        accountNumber: vaData.data.account_number,
        bankName: vaData.data.account_bank_name,
        note: vaData.data.note || null,
        reference,
        expiresAt: vaData.data.account_expiration_datetime
      })
    };
  } catch (e) {
    console.error('create-virtual-account error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
