// netlify/functions/withdraw-request.js
//
// Handles a user's "Withdraw to bank" request.
//
// Payout model (manual-approval, same shape as Bigisub settlement in
// manual-settlement.js): Flutterwave's Transfers API needs IP whitelisting
// that Netlify's rotating IPs can't satisfy yet (see _settlementCore.js),
// so this does NOT call the Transfers API directly. Instead:
//
//   1. The wallet is debited immediately, in the same Firestore
//      transaction that creates the withdrawal record — this "reserves"
//      the funds so the user can't spend money that's already earmarked
//      for a pending withdrawal, and can't submit the same withdrawal
//      twice by double-tapping.
//   2. A `withdrawals/{id}` doc is created with status 'pending', plus a
//      matching `transactions/{id}` doc (status 'pending', negative
//      amount) so it shows up in the user's history immediately with a
//      pending badge — real-time feedback even before any human acts on
//      it, via the same Firestore listener the rest of the app already
//      uses for transaction status.
//   3. The admin sees it in admin.html's Withdrawals tab, pays the user's
//      bank account manually via the Flutterwave dashboard (or any bank
//      app), then clicks Approve — which flips both docs to 'success' and
//      notifies the user. See admin-approve-withdrawal.js.
//   4. If the admin rejects instead (bad account details, suspected
//      fraud, etc.), the reserved funds are refunded back to the wallet.
//
// Body: { idToken, uid, amount, pin, bankCode, bankName, accountNumber, accountName }
// Returns: { ok, newBalance, withdrawalId } or { ok:false, error, pinError? }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const crypto = require('crypto');
const { notifyUser } = require('./_notify');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'vtusurpport@gmail.com';

// Same withdrawal minimum a bank transfer app would enforce — protects
// against a spam of near-zero withdrawal requests cluttering the admin
// queue. Configurable here in one place if the business wants it changed.
const MIN_WITHDRAWAL = 500;

function hashPin(pin, uid) {
  return crypto.createHash('sha256').update(`${pin}:${uid}`).digest('hex');
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Best-effort email so a new withdrawal doesn't just sit silently until
// someone happens to open admin.html — mirrors _adminAlert.js's pattern
// but for "action needed", not "failure occurred".
async function sendAdminWithdrawalAlert({ amount, bankName, accountNumber, accountName, userEmail, uid }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) return;
  const when = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a7a3c;margin:0 0 12px;">💸 New Withdrawal Request</h2>
      <p style="color:#444;font-size:14px;">A user has requested a bank withdrawal. Pay this manually within 24 hours, then approve it in the admin dashboard.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0;">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Amount</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">₦${escapeHtml(amount)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Bank</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">${escapeHtml(bankName)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Account Number</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">${escapeHtml(accountNumber)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">Account Name</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">${escapeHtml(accountName)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#555;">User Email</td><td style="padding:8px 0;border-bottom:1px solid #eee;color:#111;font-weight:600;">${escapeHtml(userEmail)}</td></tr>
        <tr><td style="padding:8px 0;color:#555;">Date & Time</td><td style="padding:8px 0;color:#111;font-weight:600;">${escapeHtml(when)}</td></tr>
      </table>
    </div>`;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'WoodPay Alerts', email: BREVO_SENDER_EMAIL },
        to: [{ email: ADMIN_NOTIFY_EMAIL }],
        subject: `💸 New Withdrawal Request — ₦${amount}`,
        htmlContent: html
      })
    });
  } catch (e) {
    console.log('sendAdminWithdrawalAlert failed:', e.message);
  }
}

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

  const { idToken, uid, amount, pin, bankCode, bankName, accountNumber, accountName } = body;

  if (!idToken || !uid || !amount || !pin || !bankCode || !bankName || !accountNumber || !accountName) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }
  const amt = Number(amount);
  if (!(amt > 0)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Enter a valid amount.' }) };
  }
  if (amt < MIN_WITHDRAWAL) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: `Minimum withdrawal is ₦${MIN_WITHDRAWAL}.` }) };
  }
  if (!/^\d{10}$/.test(String(accountNumber))) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Account number must be 10 digits.' }) };
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

  const userRef = db.collection('users').doc(uid);
  const withdrawalRef = db.collection('withdrawals').doc();
  const txRef = db.collection('transactions').doc();

  try {
    let newBalance;
    let userEmail;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found.');
      const userData = userSnap.data();
      userEmail = userData.email;

      // PIN check — withdrawing is a debit, same gate as any other purchase.
      const storedHash = userData.pinHash;
      if (storedHash) {
        if (hashPin(pin, uid) !== storedHash) {
          throw Object.assign(new Error('Incorrect PIN.'), { pinError: 'INVALID_PIN' });
        }
      } else {
        throw Object.assign(new Error('Please set up a transaction PIN first.'), { pinError: 'PIN_REQUIRED' });
      }

      const currentBalance = userData.walletBalance || 0;
      if (currentBalance < amt) {
        throw new Error('Insufficient wallet balance.');
      }

      newBalance = currentBalance - amt;
      tx.update(userRef, { walletBalance: newBalance });

      tx.set(withdrawalRef, {
        userId: uid,
        userEmail: userEmail || null,
        amount: amt,
        bankCode: String(bankCode),
        bankName,
        accountNumber: String(accountNumber),
        accountName,
        status: 'pending', // pending -> success | rejected
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Same transactions collection everything else writes to, so it
      // shows up in the user's normal history/receipt UI for free —
      // txLabel()/txDetailLines() in index.html just need a 'withdrawal' case.
      tx.set(txRef, {
        userId: uid,
        type: 'withdrawal',
        amount: -amt, // negative: money leaving the wallet
        status: 'pending',
        bankName,
        accountNumber: String(accountNumber),
        accountName,
        withdrawalId: withdrawalRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    await notifyUser(admin, db, uid, {
      title: 'Withdrawal request received',
      body: `Your ₦${amt} withdrawal to ${accountName} (${bankName}) is being processed. You'll be notified once it's paid — usually within 24 hours.`,
      type: 'info',
      url: '/',
      from: 'olives'
    });

    // Best-effort — never block the user's response on this.
    sendAdminWithdrawalAlert({ amount: amt, bankName, accountNumber, accountName, userEmail, uid }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, newBalance, withdrawalId: withdrawalRef.id })
    };
  } catch (e) {
    console.error('withdraw-request error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: e.message, pinError: e.pinError || null })
    };
  }
};
