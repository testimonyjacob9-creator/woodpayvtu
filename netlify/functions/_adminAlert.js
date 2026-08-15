// netlify/functions/_adminAlert.js
//
// Sends a best-effort email to the admin inbox whenever a transaction
// fails, so failures show up in an inbox instead of only in Firestore /
// the admin dashboard. Used by:
//   - send-email.js        (customer-facing purchase/delivery failures)
//   - flw-v3-webhook.js    (wallet funding failures reported by Flutterwave)
//
// Uses the same Brevo config as send-email.js:
//   BREVO_API_KEY, BREVO_SENDER_EMAIL, ADMIN_NOTIFY_EMAIL
// If BREVO_API_KEY/BREVO_SENDER_EMAIL aren't set, this silently no-ops —
// callers should never let this failure block the actual request.

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'vtusurpport@gmail.com';

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function row(label, value) {
  return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">${escapeHtml(label)}</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">${escapeHtml(value)}</td></tr>`;
}

// details: { source, txType, provider, amount, ref, reason, userEmail, uid }
async function sendAdminFailureAlert(details = {}) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.log('_adminAlert: skipped — BREVO_API_KEY or BREVO_SENDER_EMAIL not set');
    return { ok: false, skipped: true };
  }

  const when = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#c0392b;margin:0 0 12px;">⚠️ Failed Transaction Alert</h2>
      <p style="color:#444;font-size:14px;">A transaction just failed on WoodPay. Details below:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        ${row('Source', details.source || 'unknown')}
        ${row('Transaction Type', details.txType || '—')}
        ${row('Provider / Network', details.provider || '—')}
        ${details.amount != null ? row('Amount', '₦' + details.amount) : ''}
        ${row('Reference', details.ref || '—')}
        ${row('Reason', details.reason || '—')}
        ${row('User Email', details.userEmail || '—')}
        ${details.uid ? row('User UID', details.uid) : ''}
        ${row('Date & Time', when)}
      </table>
    </div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'WoodPay Alerts', email: BREVO_SENDER_EMAIL },
        to: [{ email: ADMIN_NOTIFY_EMAIL }],
        subject: `⚠️ Failed Transaction — ${details.txType || 'transaction'}${details.ref ? ' — ' + details.ref : ''}`,
        htmlContent: html
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.log('_adminAlert: Brevo send failed:', res.status, errText.slice(0, 200));
      return { ok: false, reason: `Brevo HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    // Never let an alert-email failure break the caller's real request.
    console.log('_adminAlert: send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { sendAdminFailureAlert };
