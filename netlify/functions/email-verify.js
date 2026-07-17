// netlify/functions/email-verify.js
// Sends and verifies 6-digit email verification codes.
// Codes are stored in Firestore with a 10-minute TTL.
//
// Body (send):    { action: 'send', uid, email, name }
// Body (confirm): { action: 'confirm', uid, code }
// Returns: { ok } or { ok: false, error }
//
// Env vars needed:
//   BREVO_API_KEY      - Brevo (formerly Sendinblue) API key
//   BREVO_SENDER_EMAIL - verified sender address, e.g. vtusurpport@gmail.com

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmail(to, name, code) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.warn('BREVO_API_KEY or BREVO_SENDER_EMAIL not set — skipping email send');
    return { ok: true, skipped: true };
  }
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1a1a2e">Verify your email</h2>
      <p>Hi ${name || 'there'},</p>
      <p>Your WoodPay verification code is:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#6c63ff;margin:24px 0">${code}</div>
      <p style="color:#666">This code expires in 10 minutes. Do not share it with anyone.</p>
    </div>`;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject: 'Your WoodPay verification code',
        htmlContent: html
      })
    });
    return { ok: res.ok };
  } catch (e) {
    console.error('email-verify send error:', e.message);
    return { ok: false, error: e.message };
  }
}

exports.handler = async (event) => {
  if (ADMIN_INIT_ERROR) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  const db = admin.firestore();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, uid, email, name, code } = body;

  if (!action || !uid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing action or uid' }) };
  }

  if (action === 'send') {
    if (!email) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing email' }) };

    const newCode = genCode();
    const expiresAt = Date.now() + CODE_TTL_MS;

    try {
      await db.collection('emailVerifyCodes').doc(uid).set({ code: newCode, expiresAt, email });
      await sendEmail(email, name, newCode);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      };
    } catch (e) {
      console.error('email-verify store error:', e.message);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Could not send verification code.' })
      };
    }
  }

  if (action === 'confirm') {
    if (!code) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing code' }) };

    try {
      const docSnap = await db.collection('emailVerifyCodes').doc(uid).get();
      if (!docSnap.exists) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'No verification code found. Please request a new one.' })
        };
      }
      const stored = docSnap.data();
      if (Date.now() > stored.expiresAt) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'Code expired. Please request a new one.' })
        };
      }
      if (stored.code !== String(code).trim()) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'Incorrect code.' })
        };
      }
      // Mark email verified in Firebase Auth + delete the code doc
      await Promise.all([
        admin.auth().updateUser(uid, { emailVerified: true }),
        db.collection('emailVerifyCodes').doc(uid).delete()
      ]);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      };
    } catch (e) {
      console.error('email-verify confirm error:', e.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Verification failed. Please try again.' })
      };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` }) };
};
