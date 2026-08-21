// netlify/functions/resolve-bank-account.js
//
// Resolves a Nigerian bank account number + bank code to the account's
// registered name, via Flutterwave's account-resolve endpoint. Shown in
// the withdraw sheet the same way send-money shows the WoodPay recipient's
// name — so the user can confirm "yes, that's my account" before money
// moves, instead of finding out after a transfer bounces or lands
// somewhere wrong.
//
// This does NOT move money and does NOT require auth beyond a valid
// Firebase session — it's a read-only lookup against Flutterwave, same
// trust level as the p2p lookup-user-by-phone function.
//
// Body: { idToken, accountNumber, bankCode }
// Returns: { ok, accountName } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const FLW_V3_BASE = 'https://api.flutterwave.com/v3';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';

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

  const { idToken, accountNumber, bankCode } = body;
  if (!idToken || !accountNumber || !bankCode) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Account number must be 10 digits.' }) };
  }

  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }

  try {
    const res = await fetch(`${FLW_V3_BASE}/accounts/resolve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ account_number: String(accountNumber), account_bank: String(bankCode) })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.status !== 'success' || !data.data) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: data.message || 'Could not verify that account number.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, accountName: data.data.account_name })
    };
  } catch (e) {
    console.error('resolve-bank-account error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
