// netlify/functions/create-permanent-account.js
//
// Creates a Flutterwave v4 STATIC virtual account (Sterling Bank) for a
// user, after they submit their NIN. Unlike create-virtual-account.js
// (dynamic, single-use, exact-amount, 30-min expiry), a static account:
//   - never expires
//   - is reused for every future top-up
//   - accepts any amount transferred to it
//
// Flutterwave requires either a BVN or a NIN to create a static account
// (identity verification requirement, not something we can skip). We use
// NIN here per product decision.
//
// IMPORTANT — before this goes live:
// The webhook (flw-v4-webhook.js) matches incoming transfers to a static
// account by the Flutterwave customer_id embedded in the webhook payload,
// since (unlike the dynamic flow) there's no pending transaction with a
// known reference to match against for an unprompted top-up. This should
// be tested with one real sandbox transfer before trusting it in
// production — confirm the webhook payload actually includes the
// customer id in the field this code expects, and adjust if not.
//
// Body:  { idToken, uid, nin, ninName }
// Returns: { ok, accountNumber, bankName } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { getFlwV4Token } = require('./_flwV4Auth');

const FLW_V4_BASE = 'https://f4bexperience.flutterwave.com';
const STERLING_BANK_CODE = '232';
const NIN_REGEX = /^[1-9][0-9]{10}$/; // Flutterwave's own validation pattern for nin/bvn

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

    // Already has one — don't create a second static account for the same user.
    if (userData.permanentAccount && userData.permanentAccount.accountNumber) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          accountNumber: userData.permanentAccount.accountNumber,
          bankName: userData.permanentAccount.bankName
        })
      };
    }

    const email = userData.email || decoded.email;
    const name = cleanName; // use the name they entered as-on-their-NIN, not the old profile name
    const [first, ...rest] = name.split(' ');
    const last = rest.join(' ') || first;

    const token = await getFlwV4Token();

    // Reuse the same cached Flutterwave customer as the dynamic-account flow.
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
      await userRef.update({ flwCustomerId: customerId });
    }

    const reference = `WPSTATIC${uid.slice(0, 12)}${Date.now().toString(36).toUpperCase()}`;

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
        amount: 0, // required to be 0 for static accounts
        currency: 'NGN',
        account_type: 'static',
        narration: name,
        bank_code: STERLING_BANK_CODE,
        nin: String(nin)
      })
    });
    const vaData = await vaRes.json();

    if (!vaRes.ok || !vaData.data || !vaData.data.account_number) {
      console.error('flw v4 static account create error:', vaData);
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
      flwCustomerId: customerId,
      permanentAccount: {
        accountNumber: vaData.data.account_number,
        bankName: vaData.data.account_bank_name,
        virtualAccountId: vaData.data.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        accountNumber: vaData.data.account_number,
        bankName: vaData.data.account_bank_name
      })
    };
  } catch (e) {
    console.error('create-permanent-account error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
