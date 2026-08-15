// netlify/functions/create-virtual-account.js
//
// Creates a Flutterwave v3 DYNAMIC virtual account on Wema Bank
// (bank_code "035") for a single wallet-funding request.
//
// Migrated from v4 to v3 (Aug 2026): v4's virtual-account product was
// issuing account numbers that looked valid but were never actually
// registered on NIBSS, so real transfers into them bounced as "invalid
// account" — first on Sterling Bank (232), then still broken after
// switching to Wema (035). That ruled out a bank-specific fix. v3 is
// Flutterwave's older, far more mature virtual-account product and
// doesn't have this gap. See flw-v3-webhook.js for the matching webhook.
//
// v3 also simplifies account creation vs v4: there's no separate
// "customer" object to create/cache first — email/name/phone are passed
// directly on the virtual-account-numbers call itself.
//
// Body:  { idToken, uid, amount }
// Returns: { ok, accountNumber, bankName, reference, expiresAt } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const FLW_V3_BASE = 'https://api.flutterwave.com/v3';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';
// Switched from Sterling Bank (232) to Wema Bank (035) after Sterling VAs
// stopped resolving on NIBSS (both static + dynamic accounts returning
// "Invalid Account" / "No Account Found" as of 15 Aug 2026). Wema is one of
// Flutterwave's confirmed virtual-account-issuing partner banks.
const ISSUING_BANK_CODE = '035';

// Flutterwave's dashboard "charge my customer" toggle only auto-applies to
// their own hosted checkout — it does NOT adjust amounts we set directly
// through the API. So if you want customers to cover the transaction fee
// (rather than you absorbing it out of your margin), we calculate it here
// ourselves. Current NGN collection fee is 2% (1.4% processing + 0.6%
// platform) plus 7.5% VAT on that fee — effectively ~2.15%. If Flutterwave
// changes this rate, update FEE_RATE below. Must match flw-v3-webhook.js
// and create-permanent-account.js.
const FEE_RATE = 0.0215;

function feeInclusiveAmount(baseAmount) {
  return Math.ceil(baseAmount * (1 + FEE_RATE));
}

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  if (!FLW_SECRET_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'FLW_SECRET_KEY env var is not set.' }) };
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

    // Create the dynamic virtual account for this specific amount.
    // The customer transfers chargeAmount (their requested top-up + our fee),
    // but their wallet is only ever credited the original amount they asked
    // to fund — the fee difference covers what Flutterwave deducts from us.
    const reference = `WPVA${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const chargeAmount = feeInclusiveAmount(Number(amount));

    // TEMP DIAGNOSTIC — remove once "Invalid authorization key" is resolved.
    // Logs only length + a masked prefix, never the full secret.
    console.log('[FLW DIAG] key length:', FLW_SECRET_KEY.length,
      '| prefix:', JSON.stringify(FLW_SECRET_KEY.slice(0, 8)),
      '| starts FLWSECK-:', FLW_SECRET_KEY.startsWith('FLWSECK-'),
      '| starts FLWSECK_TEST-:', FLW_SECRET_KEY.startsWith('FLWSECK_TEST-'),
      '| has whitespace/newline:', /\s/.test(FLW_SECRET_KEY),
      '| has quote chars:', /['"]/.test(FLW_SECRET_KEY));

    const vaRes = await fetch(`${FLW_V3_BASE}/virtual-account-numbers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        tx_ref: reference,
        amount: chargeAmount,
        currency: 'NGN',
        bank_code: ISSUING_BANK_CODE,
        phonenumber: userData.phone || '',
        firstname: first || 'WoodPay',
        lastname: last || 'Customer',
        narration: name
      })
    });
    const vaData = await vaRes.json();

    // TEMP DIAGNOSTIC — remove once resolved.
    console.log('[FLW DIAG] status:', vaRes.status, '| body:', JSON.stringify(vaData));

    if (!vaRes.ok || vaData.status !== 'success' || !vaData.data || !vaData.data.account_number) {
      console.error('flw v3 virtual account create error:', vaData);
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: vaData.message || 'Could not generate virtual account.' }) };
    }

    // Record a pending funding transaction so the webhook has something to
    // match against and credit once the transfer lands. amount = what the
    // wallet gets credited. chargeAmount = what Flutterwave actually
    // expects the customer to transfer (amount + our fee cover).
    await db.collection('transactions').doc().set({
      userId: uid,
      type: 'wallet_funding_dynamic',
      amount: Number(amount),
      chargeAmount,
      status: 'pending',
      reference,
      flwRef: vaData.data.flw_ref || null,
      orderRef: vaData.data.order_ref || null,
      accountNumber: vaData.data.account_number,
      bankName: vaData.data.bank_name,
      note: vaData.data.note || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        chargeAmount,
        accountNumber: vaData.data.account_number,
        bankName: vaData.data.bank_name,
        note: vaData.data.note || null,
        reference,
        expiresAt: vaData.data.expiry_date
      })
    };
  } catch (e) {
    console.error('create-virtual-account error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
