// netlify/functions/verify-payment.js
// Verifies a Flutterwave transaction server-side using FLW_SECRET_KEY.
// Never trust the client's reported transaction status — always re-verify here.
//
// Body: { transactionId, expectedAmount, expectedTxRef }
// Returns: { ok, data? } or { ok: false, error }

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { transactionId, expectedAmount, expectedTxRef } = body;

  if (!transactionId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing transactionId' }) };
  }

  if (!FLW_SECRET_KEY) {
    console.error('FLW_SECRET_KEY env var is not set');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Payment verification not configured. Contact support.' })
    };
  }

  try {
    const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` }
    });

    const data = await res.json();

    if (!res.ok || data.status !== 'success') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: data.message || 'Verification failed' })
      };
    }

    const tx = data.data;

    // Validate amount and currency
    if (expectedAmount && Math.abs(tx.amount - Number(expectedAmount)) > 1) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Amount mismatch — possible fraud attempt.' })
      };
    }

    if (expectedTxRef && tx.tx_ref !== expectedTxRef) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Transaction reference mismatch.' })
      };
    }

    if (tx.status !== 'successful') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: `Payment status: ${tx.status}` })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, data: tx })
    };
  } catch (e) {
    console.error('verify-payment error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Could not reach verification server. Contact support if you were charged.' })
    };
  }
};
