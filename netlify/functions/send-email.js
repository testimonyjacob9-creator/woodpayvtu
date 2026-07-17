// netlify/functions/send-email.js
//
// This function was missing from the project — that's why the contact
// form in index.html showed "Failed to send message. Please try again."
// (it was fetching /.netlify/functions/send-email, which returned 404).
//
// It's called from three places with two different payload shapes:
//   1. index.html contact form:
//        { template: 'contact', email, subject, message }
//   2. netlify/functions/send-push.js email fallback:
//        { template: 'notification', email, subject, message }
//   3. admin.html broadcast tool:
//        { type: 'custom', toEmail, toName, data: { subject, html } }
//
// Behaviour:
//   - 'contact' messages are ALWAYS saved to a Firestore `contactMessages`
//     collection (via the Admin SDK, so security rules don't apply here)
//     so they show up in the admin dashboard's Messages tab even if no
//     email provider is configured. Sending an actual email to the admin
//     inbox is attempted on top of that, but is best-effort.
//   - 'notification' / 'custom' emails go straight to the recipient via
//     the configured email provider. If no provider is configured, this
//     returns ok:false so the caller's "sent/failed" counters stay honest.
//
// EMAIL PROVIDER: uses Brevo (https://brevo.com), since BREVO_API_KEY and
// BREVO_SENDER_EMAIL were already configured in Netlify — a Resend-based
// version of this file was previously here expecting different env var
// names (RESEND_API_KEY / RESEND_FROM), which were never set, so every
// email silently no-op'd while callers still reported success.
//   BREVO_API_KEY       - your Brevo API key
//   BREVO_SENDER_EMAIL  - verified sender address, e.g. vtusurpport@gmail.com
//   ADMIN_NOTIFY_EMAIL  - inbox that should receive contact-form messages
//                        (defaults to vtusurpport@gmail.com below — the
//                        address already shown to users in the in-app FAQ)
// Without BREVO_API_KEY set, contact messages still land in Firestore —
// you just won't get an email ping, which is why checking the admin
// dashboard's Messages tab regularly still matters.

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'vtusurpport@gmail.com';

async function sendViaBrevo({ to, replyTo, subject, html }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) return { ok: false, skipped: true, reason: 'BREVO_API_KEY or BREVO_SENDER_EMAIL not set' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject,
        htmlContent: html
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, reason: `Brevo HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

exports.handler = async (event) => {
  console.log('send-email FN VERSION v12 — received body:', event.body);
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  const db = admin.firestore();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Build the subject/body for the transactional emails sent by
  // sendWoodPayEmail() in index.html: 'welcome', 'transaction', 'failed'.
  // These arrive as { type, toEmail, toName, data } — no subject/message —
  // so we generate the full styled WoodPay design here (matches the
  // approved templates), not bare <p> tags. Email clients (Gmail etc.)
  // strip <style> blocks unpredictably, so everything is inlined.
  function emailShell({ headerGradient, tagline, bodyHtml }) {
    return `
<div style="background:#f0f0f0;padding:20px;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:${headerGradient};padding:35px 40px;text-align:center;">
      <div style="color:#ffffff;font-size:28px;font-weight:800;letter-spacing:-1px;">Wood<span style="color:#7fffb8;">Pay</span></div>
      <div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:5px;">${tagline}</div>
    </div>
    <div style="padding:40px;">
      ${bodyHtml}
    </div>
    <div style="background:#f7f7f7;padding:25px 40px;text-align:center;">
      <p style="font-size:12px;color:#999;line-height:1.8;margin:0;">© 2026 WoodPay. All rights reserved.<br>
      <a href="https://woodpay.netlify.app" style="color:#1a7a4a;text-decoration:none;">Visit WoodPay</a></p>
    </div>
  </div>
</div>`;
  }

  function txnRow(label, value){
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#444;">${label}</td><td style="padding:12px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#111;font-weight:600;text-align:right;">${value}</td></tr>`;
  }

  function buildWoodPayContent(type, toName, data) {
    const name = escapeHtml(toName || 'there');

    if (type === 'welcome') {
      const bodyHtml = `
        <p style="font-size:11px;font-weight:700;color:#1a7a4a;text-transform:uppercase;letter-spacing:1px;margin:0 0 5px;">Welcome</p>
        <h2 style="font-size:22px;color:#111;margin:0 0 10px;">Your account is ready 🎉</h2>
        <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">Hi <strong>${name}</strong>,</p>
        <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">Welcome to WoodPay! Your account has been created successfully. You can now buy data, airtime, pay for TV subscriptions, and electricity — all in one place.</p>
        <a href="https://woodpay.netlify.app" style="display:inline-block;background:#1a7a4a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;margin:10px 0 20px;">Go to My Dashboard →</a>
        <hr style="border:none;border-top:1px solid #eee;margin:25px 0;">
        <p style="font-size:13px;color:#888;margin:0;">If you didn't create this account, please ignore this email or contact us immediately.</p>`;
      return {
        subject: 'Welcome to WoodPay!',
        html: emailShell({ headerGradient: 'linear-gradient(135deg,#1a7a4a 0%,#0d5c35 100%)', tagline: 'Data · Airtime · TV · Electricity', bodyHtml })
      };
    }

    if (type === 'transaction') {
      const d = data || {};
      const type_ = escapeHtml(d.type || '');
      const provider = escapeHtml(d.provider || '');
      const amount = escapeHtml(d.amount);
      const ref = escapeHtml(d.ref || '');
      const when = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
      const bodyHtml = `
        <p style="font-size:11px;font-weight:700;color:#1a7a4a;text-transform:uppercase;letter-spacing:1px;margin:0 0 5px;">Receipt</p>
        <h2 style="font-size:22px;color:#111;margin:0 0 10px;">Transaction Successful ✅</h2>
        <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">Hi <strong>${name}</strong>, your transaction was completed successfully. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          ${txnRow('Transaction Type', type_)}
          ${txnRow('Network / Provider', provider)}
          ${txnRow('Amount', '₦' + amount)}
          ${txnRow('Reference ID', ref)}
          ${txnRow('Date & Time', when)}
          ${txnRow('Status', '<span style="display:inline-block;background:#e6f9ee;color:#1a7a4a;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">✅ Successful</span>')}
        </table>
        <a href="https://woodpay.netlify.app" style="display:inline-block;background:#1a7a4a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;margin:10px 0 20px;">View Transaction History →</a>
        <hr style="border:none;border-top:1px solid #eee;margin:25px 0;">
        <p style="font-size:13px;color:#888;margin:0;">If you did not make this transaction, please contact us immediately at <a href="mailto:${ADMIN_NOTIFY_EMAIL}" style="color:#1a7a4a;">${ADMIN_NOTIFY_EMAIL}</a></p>`;
      return {
        subject: `Payment Successful — ₦${amount}`,
        html: emailShell({ headerGradient: 'linear-gradient(135deg,#1a7a4a 0%,#0d5c35 100%)', tagline: 'Transaction Receipt', bodyHtml })
      };
    }

    if (type === 'failed') {
      const d = data || {};
      const type_ = escapeHtml(d.type || '');
      const amount = escapeHtml(d.amount);
      const ref = escapeHtml(d.ref || '');
      const reason = escapeHtml(d.reason || 'Delivery failed');
      const when = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
      const bodyHtml = `
        <p style="font-size:11px;font-weight:700;color:#c0392b;text-transform:uppercase;letter-spacing:1px;margin:0 0 5px;">Alert</p>
        <h2 style="font-size:22px;color:#111;margin:0 0 10px;">Transaction Failed ❌</h2>
        <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">Hi <strong>${name}</strong>, unfortunately your recent transaction could not be completed. The amount has been <strong>refunded to your WoodPay wallet</strong>. Here are the details:</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          ${txnRow('Transaction Type', type_)}
          ${txnRow('Amount', '₦' + amount)}
          ${txnRow('Reference ID', ref)}
          ${txnRow('Failure Reason', reason)}
          ${txnRow('Date & Time', when)}
          ${txnRow('Status', '<span style="display:inline-block;background:#fde8e8;color:#c0392b;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">❌ Failed — Refunded</span>')}
        </table>
        <a href="https://woodpay.netlify.app" style="display:inline-block;background:#c0392b;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;margin:10px 0 20px;">Try Again →</a>
        <hr style="border:none;border-top:1px solid #eee;margin:25px 0;">
        <p style="font-size:14px;color:#555;margin:0 0 8px;"><strong>What to do next:</strong></p>
        <p style="font-size:13px;color:#888;margin:0;">• Check your internet connection and try again<br>• Make sure your wallet balance is sufficient<br>• Contact us if the problem continues</p>`;
      return {
        subject: `Transaction Failed — Refunded`,
        html: emailShell({ headerGradient: 'linear-gradient(135deg,#c0392b 0%,#922b21 100%)', tagline: 'Transaction Alert', bodyHtml })
      };
    }

    return { subject: body.subject || '(no subject)', html: `<p>${escapeHtml(body.message || '').replace(/\n/g, '<br>')}</p>` };
  }


  // Normalize the different payload shapes into one internal shape.
  let kind, toEmail, subject, html, recipientEmail;

  if (body.type === 'custom') {
    kind = 'custom';
    toEmail = body.toEmail;
    subject = body.data?.subject || '(no subject)';
    html = body.data?.html || '';
  } else if (body.toEmail) {
    // sendWoodPayEmail() payload: { type: 'welcome'|'transaction'|'failed', toEmail, toName, data }
    kind = 'notification';
    recipientEmail = body.toEmail;
    ({ subject, html } = buildWoodPayContent(body.type, body.toName, body.data));
  } else {
    kind = body.template || 'notification';
    recipientEmail = body.email;
    subject = body.subject || '(no subject)';
    html = `<p>${escapeHtml(body.message || '').replace(/\n/g, '<br>')}</p>`;
  }

  // ---- Contact form: persist to Firestore so it reaches the admin ----
  if (kind === 'contact') {
    if (!recipientEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing sender email' }) };
    }
    try {
      await db.collection('contactMessages').add({
        fromEmail: recipientEmail,
        subject: body.subject || '(no subject)',
        message: body.message || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      });
    } catch (e) {
      console.error('Failed to save contact message to Firestore:', e);
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save message' }) };
    }

    // Best-effort email ping to the admin inbox — failure here does NOT
    // fail the request, since the message is already saved above.
    const emailResult = await sendViaBrevo({
      to: ADMIN_NOTIFY_EMAIL,
      replyTo: recipientEmail,
      subject: `[WoodPay Contact] ${body.subject || '(no subject)'}`,
      html: `<p><b>From:</b> ${escapeHtml(recipientEmail)}</p><p>${escapeHtml(body.message || '').replace(/\n/g, '<br>')}</p>`
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, savedToAdmin: true, emailSent: emailResult.ok })
    };
  }

  // ---- Notification fallback / admin broadcast: email the recipient ----
  const recipient = kind === 'custom' ? toEmail : recipientEmail;
  if (!recipient) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing recipient email' }) };
  }

  const result = await sendViaBrevo({
    to: recipient,
    subject,
    html
  });

  if (!result.ok) {
    console.warn('Email not sent:', result.reason);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: result.reason })
    };
  }

  console.log('Email accepted by Brevo for delivery to:', recipient, '— subject:', subject);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
