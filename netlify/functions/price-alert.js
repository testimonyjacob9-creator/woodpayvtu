// netlify/functions/price-alert.js
//
// Called (fire-and-forget) from index.html whenever a data-plan purchase's
// actual Bigisub buy price differs from what WoodPay's static PRICING
// catalog expected (see the buyPriceCorrected logic in processDelivery()).
// This is the one place prices genuinely change at runtime — the catalog
// itself is static and only changes via a code deploy, which git already
// tracks, so there's nothing to "watch" there.
//
// Body: { planName, network, expectedBuy, actualBuy, sellPrice, ref }
// Always returns 200 — this must never fail or block the purchase flow
// that triggered it.

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'vtusurpport@gmail.com';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 200, body: JSON.stringify({ ok: false }) }; }

  const { planName, network, expectedBuy, actualBuy, sellPrice, ref } = body || {};
  if (typeof expectedBuy !== 'number' || typeof actualBuy !== 'number') {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Missing price fields' }) };
  }
  // Ignore noise — a few naira of drift happens constantly and isn't
  // worth an email; only alert on a move big enough to actually matter
  // to margin.
  const drift = actualBuy - expectedBuy;
  if (Math.abs(drift) < 5) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'drift too small' }) };
  }

  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.log('price-alert: skipped — Brevo not configured');
    return { statusCode: 200, body: JSON.stringify({ ok: false, skipped: true }) };
  }

  const marginBefore = (sellPrice != null) ? Number(sellPrice) - expectedBuy : null;
  const marginAfter = (sellPrice != null) ? Number(sellPrice) - actualBuy : null;
  const direction = drift > 0 ? 'went UP' : 'went DOWN';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:${drift > 0 ? '#c0392b' : '#1a7a4a'};margin:0 0 12px;">💰 Olives noticed a price change</h2>
      <p style="color:#444;font-size:14px;">Bigisub's live cost for a plan ${direction} compared to WoodPay's saved price. Details:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Plan</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">${escapeHtml(planName || '—')} ${network ? '(' + escapeHtml(network) + ')' : ''}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Expected buy price</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">₦${expectedBuy}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Actual buy price (just now)</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">₦${actualBuy}</td></tr>
        ${sellPrice != null ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Your sell price</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">₦${sellPrice}</td></tr>` : ''}
        ${marginBefore != null ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Margin before → after</td><td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:600;">₦${marginBefore} → ₦${marginAfter}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:#555;">Reference</td><td style="padding:8px 0;font-weight:600;">${escapeHtml(ref || '—')}</td></tr>
      </table>
      <p style="color:#888;font-size:12.5px;">This transaction was already auto-corrected to charge the real cost — this is just a heads-up in case you want to update your listed price for this plan.</p>
    </div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Olives from WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: ADMIN_NOTIFY_EMAIL }],
        subject: `💰 Price ${direction.toLowerCase()} — ${planName || 'a plan'}`,
        htmlContent: html
      })
    });
    return { statusCode: 200, body: JSON.stringify({ ok: res.ok }) };
  } catch (e) {
    console.log('price-alert: send failed:', e.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
