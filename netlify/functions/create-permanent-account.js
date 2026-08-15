// netlify/functions/create-permanent-account.js
//
// Creates a Flutterwave v3 STATIC virtual account (Wema Bank) for a
// user, after they submit their NIN. Unlike create-virtual-account.js
// (dynamic, single-use, exact-amount, 30-min expiry), a static account:
//   - never expires
//   - is reused for every future top-up
//   - accepts any amount transferred to it
//
// Migrated from v4 to v3 (Aug 2026) — see the comment at the top of
// create-virtual-account.js for why.
//
// Flutterwave v3 requires either a BVN or a NIN to create a static
// account (identity verification requirement — confirmed still true on
// v3's live docs as of this migration: the `nin` field is accepted in
// place of `bvn`). We use NIN here per product decision, same as before.
//
// Matching incoming transfers back to this account: the webhook
// (flw-v3-webhook.js) matches primarily on `tx_ref` — Flutterwave reuses
// this exact reference on every charge into a static account, so it's
// the reliable match, same limitation v3 has as v4 (no destination
// account number in the webhook payload). See the comment above
// handlePossibleStaticAccountTransfer() in flw-v3-webhook.js for the
// full explanation.
//
// Body:  { idToken, uid, nin, ninName }
// Returns: { ok, accountNumber, bankName } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const FLW_V3_BASE = 'https://api.flutterwave.com/v3';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';
const ISSUING_BANK_CODE = '035'; // Wema Bank
const NIN_REGEX = /^[1-9][0-9]{10}$/; // Flutterwave's own validation pattern for nin/bvn

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

  const { idToken, uid, nin, ninName } = body;

  if (!idToken || !uid || !nin || !ninName) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }
  if (!NIN_REGEX.test(String(nin))) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'NIN must be exactly 11 digits.' }) };
  }
  const cleanName = String(ninName).trim().replace(/\s+/g, ' ');
  if (cleanName.length < 3 || !cleanName.includes(' ')) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Enter a full name (first and last).' }) };
  }

  const db = admin.firestore();

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
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'User not found.' }) };
    }
    const userData = userSnap.data();

    // Already has a working static account (Wema, v3 or v4) — don't create
    // a second one. If they have an old broken Sterling account on file,
    // fall through and regenerate on Wema instead (requires the user to
    // resubmit their NIN, since we never store it — see note below).
    const existing = userData.permanentAccount;
    const existingIsOldSterling = existing && existing.bankName && /sterling/i.test(existing.bankName);

    if (existing && existing.accountNumber && !existingIsOldSterling) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          accountNumber: existing.accountNumber,
          accountName: existing.accountName || userData.name,
          bankName: existing.bankName
        })
      };
    }

    const email = userData.email || decoded.email;
    const name = cleanName; // use the name they entered as-on-their-NIN, not the old profile name
    const [first, ...rest] = name.split(' ');
    const last = rest.join(' ') || first;

    const reference = `WPSTATIC${uid.slice(0, 12)}${Date.now().toString(36).toUpperCase()}`;

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
        currency: 'NGN',
        is_permanent: true,
        bank_code: ISSUING_BANK_CODE,
        phonenumber: userData.phone || '',
        firstname: first || 'WoodPay',
        lastname: last || 'Customer',
        narration: name,
        nin: String(nin)
      })
    });
    const vaData = await vaRes.json();

    // TEMP DIAGNOSTIC — remove once resolved.
    console.log('[FLW DIAG] status:', vaRes.status, '| body:', JSON.stringify(vaData));

    if (!vaRes.ok || vaData.status !== 'success' || !vaData.data || !vaData.data.account_number) {
      console.error('flw v3 static account create error:', vaData);
      const msg = (vaData && (vaData.message || (vaData.error && vaData.error.message))) || 'Could not verify NIN or create account.';
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: msg }) };
    }

    // Deliberately NOT storing the raw NIN in Firestore — it's only ever
    // passed through to Flutterwave for the account-creation call.
    //
    // The profile name is synced here too, only now that account creation
    // actually succeeded — this is a straightforward self-declared sync to
    // what they typed as being on their NIN, not a cryptographic
    // verification against NIMC's records. Flutterwave's virtual-account
    // endpoint we use here doesn't return a verified name to check it
    // against — that would require their separate, dedicated NIN/BVN
    // verification product, which needs its own approval + consent flow.
    await userRef.update({
      name,
      permanentAccount: {
        accountNumber: vaData.data.account_number,
        accountName: name,
        bankName: vaData.data.bank_name,
        flwRef: vaData.data.flw_ref || null,
        orderRef: vaData.data.order_ref || null,
        // Flutterwave reuses this exact tx_ref on every future
        // charge.completed webhook for this static account — it's the
        // only reliable way to match an incoming transfer back to this
        // user, since the webhook payload for a static bank transfer
        // never includes a destination account number, and the
        // `customer` object in the payload is the sender, not us.
        reference,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        accountNumber: vaData.data.account_number,
        accountName: name,
        bankName: vaData.data.bank_name
      })
    };
  } catch (e) {
    console.error('create-permanent-account error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
