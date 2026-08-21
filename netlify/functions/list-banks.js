// netlify/functions/list-banks.js
//
// Returns the list of Nigerian banks (name + Flutterwave bank code) for the
// "Withdraw to bank" form's bank picker. Pulled live from Flutterwave
// rather than hardcoded, so new banks/fintechs Flutterwave adds show up
// automatically with no redeploy.
//
// No auth required — this is public reference data (bank names + codes),
// same category of info as a paper list of bank codes. Nothing user- or
// account-specific is returned.

const FLW_V3_BASE = 'https://api.flutterwave.com/v3';
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!FLW_SECRET_KEY) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'FLW_SECRET_KEY env var is not set.' }) };
  }

  try {
    const res = await fetch(`${FLW_V3_BASE}/banks/NG`, {
      headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` }
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success' || !Array.isArray(data.data)) {
      console.error('list-banks: flw error:', data);
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Could not load bank list.' }) };
    }

    // Trim to just what the client needs, sorted alphabetically for a
    // sane dropdown instead of whatever order Flutterwave returns.
    const banks = data.data
      .map(b => ({ code: b.code, name: b.name }))
      .filter(b => b.code && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      // Cache for an hour on the client/CDN — this list changes rarely,
      // no reason to hit Flutterwave on every sheet open.
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ ok: true, banks })
    };
  } catch (e) {
    console.error('list-banks error:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
