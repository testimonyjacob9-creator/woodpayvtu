// netlify/functions/password-reset.js
// Sends and confirms password reset using a 6-digit code.
// Codes are stored in Firestore keyed by email with a 15-minute TTL.
//
// Body (send):  { action: 'send', email }
// Body (reset): { action: 'reset', email, code, newPassword }
// Returns: { ok } or { ok: false, error }
//
// Env vars needed:
//   BREVO_API_KEY      - Brevo (formerly Sendinblue) API key
//   BREVO_SENDER_EMAIL - verified sender address, e.g. vtusurpport@gmail.com

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Sanitize email into a safe Firestore doc ID
function emailToKey(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

async function sendResetEmail(to, code) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) {
    console.warn('BREVO_API_KEY or BREVO_SENDER_EMAIL not set — skipping email send');
    return { ok: true, skipped: true };
  }
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1a1a2e">Reset your WoodPay password</h2>
      <p>Use the code below to reset your password. It expires in 15 minutes.</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#6c63ff;margin:24px 0">${code}</div>
      <p style="color:#666">If you didn't request this, ignore this email — your account is safe.</p>
    </div>`;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject: 'WoodPay password reset code',
        htmlContent: html
      })
    });
    return { ok: res.ok };
  } catch (e) {
    console.error('password-reset email error:', e.message);
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

  const { action, email, code, newPassword } = body;

  if (!action || !email) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing action or email' }) };
  }

  const docId = emailToKey(email);

  if (action === 'send') {
    // Look up the user to make sure the email exists
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      // Don't reveal whether the email exists — return ok silently
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      };
    }

    const newCode = genCode();
    const expiresAt = Date.now() + CODE_TTL_MS;

    try {
      await db.collection('passwordResetCodes').doc(docId).set({
        code: newCode, expiresAt, uid: userRecord.uid, email
      });
      await sendResetEmail(email, newCode);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      };
    } catch (e) {
      console.error('password-reset store error:', e.message);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Could not send reset code. Try again.' })
      };
    }
  }

  if (action === 'reset') {
    if (!code || !newPassword) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Missing code or new password' }) };
    }
    if (newPassword.length < 6) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Password must be at least 6 characters.' })
      };
    }

    try {
      const docSnap = await db.collection('passwordResetCodes').doc(docId).get();
      if (!docSnap.exists) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: false, error: 'No reset code found. Please request a new one.' })
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

      // Update password via Admin SDK + delete the code doc
      await Promise.all([
        admin.auth().updateUser(stored.uid, { password: newPassword }),
        db.collection('passwordResetCodes').doc(docId).delete()
      ]);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true })
      };
    } catch (e) {
      console.error('password-reset confirm error:', e.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Reset failed. Please try again.' })
      };
    }
  }

  return { statusCode: 400, body: JSON.stringify({ ok: false, error: `Unknown action: ${action}` }) };
};
