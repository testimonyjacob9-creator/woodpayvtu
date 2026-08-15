// netlify/functions/reconcile-pending-transactions.js
//
// Scheduled job (see netlify.toml). Runs automatically, no admin action
// needed. Looks for transactions stuck in status 'pending' and tries to
// resolve them.
//
// IMPORTANT SCOPE LIMIT — read before extending this:
// Bigisub only has a confirmed, documented "check status by reference"
// endpoint for BETTING (api/v2/betting/requery/, already used elsewhere
// in this codebase — see callBigisubAPI() in index.html). There is no
// confirmed equivalent for airtime/data/cable/electricity/ISP/recharge
// pin/result checker purchases. Guessing an endpoint for those would risk
// silently mismarking a real failure as successful — money-critical, so
// this deliberately does NOT do that. If Bigisub's docs turn up a real
// status/verify endpoint for those types later, add a branch here the
// same way betting is handled below.
//
// For everything this CAN'T auto-confirm, it still emails the admin after
// it's been stuck long enough to be worth a human look, so it's flagged
// instead of silently forgotten — but it never guesses the outcome.

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');

const BIGISUB_BASE = 'https://api.bigisub.ng/';
const BIGISUB_TOKEN = process.env.BIGISUB_TOKEN || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'vtusurpport@gmail.com';

const STUCK_AFTER_MS = 3 * 60 * 1000;         // ignore anything younger than this — still likely in-flight
const MANUAL_REVIEW_AFTER_MS = 30 * 60 * 1000; // only nag admin about un-confirmable ones once they're this old

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  return null;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function emailAdmin(subject, html) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) return;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Olives from WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: ADMIN_NOTIFY_EMAIL }],
        subject,
        htmlContent: html
      })
    });
  } catch (e) {
    console.log('reconcile: admin email failed:', e.message);
  }
}

async function bettingRequery(transactionId) {
  if (!BIGISUB_TOKEN || !transactionId) return null;
  try {
    const res = await fetch(`${BIGISUB_BASE}api/v2/betting/requery/?transaction_id=${encodeURIComponent(transactionId)}`, {
      headers: { 'Authorization': `Token ${BIGISUB_TOKEN}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return String(data.data?.status_detail || data.data?.status || '').toLowerCase();
  } catch (e) {
    console.log('reconcile: betting requery failed:', e.message);
    return null;
  }
}

exports.handler = async () => {
  if (ADMIN_INIT_ERROR) {
    console.error('reconcile-pending-transactions: Firebase not initialized:', ADMIN_INIT_ERROR);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }
  const db = admin.firestore();
  const now = Date.now();

  let pendingSnap;
  try {
    pendingSnap = await db.collection('transactions').where('status', '==', 'pending').limit(200).get();
  } catch (e) {
    console.error('reconcile-pending-transactions: query failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }

  let confirmedSuccess = 0, confirmedFailed = 0, flaggedForReview = 0;

  for (const doc of pendingSnap.docs) {
    const tx = doc.data();
    // Wallet-funding pending states are already owned by flw-v3-webhook.js
    // (driven by Flutterwave's own webhook, not something to poll here).
    if (String(tx.type || '').startsWith('wallet_funding')) continue;

    const createdMs = toMillis(tx.createdAt);
    if (!createdMs || (now - createdMs) < STUCK_AFTER_MS) continue;

    if (tx.type === 'betting' && tx.providerRef) {
      const statusDetail = await bettingRequery(tx.providerRef);
      if (statusDetail === 'successful' || statusDetail === 'success') {
        await doc.ref.update({ status: 'success', confirmedByOlives: true, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
        confirmedSuccess++;
        await notifyUser(admin, db, tx.userId, {
          title: 'Payment confirmed ✅',
          body: `Good news — your ₦${tx.amount} betting wallet funding was confirmed successful after all.`,
          type: 'success', url: '/'
        });
        await emailAdmin(
          `✅ Pending confirmed successful — ${tx.txRef || doc.id}`,
          `<p>Olives auto-confirmed a pending betting transaction as <b>successful</b> via Bigisub requery.</p>
           <p>Ref: ${escapeHtml(tx.txRef || doc.id)}<br>Amount: ₦${escapeHtml(tx.amount)}<br>User: ${escapeHtml(tx.userId)}</p>`
        );
        continue;
      }
      if (statusDetail === 'failed' || statusDetail === 'failure') {
        const reason = 'Delivery failed — confirmed by provider after initial timeout';
        const userRef = db.collection('users').doc(tx.userId);
        try {
          await db.runTransaction(async (t) => {
            const userSnap = await t.get(userRef);
            if (!userSnap.exists) throw new Error('user missing');
            const bal = userSnap.data().walletBalance || 0;
            t.update(userRef, { walletBalance: bal + Number(tx.amount || 0) });
            t.update(doc.ref, { status: 'failed', reason, refundedByOlives: true, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
          });
          confirmedFailed++;
          await notifyUser(admin, db, tx.userId, {
            title: 'Transaction failed — refunded',
            body: `Your ₦${tx.amount} betting wallet funding could not be completed. It's been refunded to your WoodPay wallet.`,
            type: 'danger', url: '/'
          });
          await emailAdmin(
            `❌ Pending confirmed failed & refunded — ${tx.txRef || doc.id}`,
            `<p>Olives auto-confirmed a pending betting transaction as <b>failed</b> via Bigisub requery, and refunded the user's wallet.</p>
             <p>Ref: ${escapeHtml(tx.txRef || doc.id)}<br>Amount: ₦${escapeHtml(tx.amount)}<br>User: ${escapeHtml(tx.userId)}</p>`
          );
        } catch (e) {
          console.log('reconcile: refund failed for', doc.id, e.message);
        }
        continue;
      }
      // Still unresolved — leave pending, try again next run.
      continue;
    }

    // Can't auto-confirm this type — only nag once it's genuinely old, and
    // only once per transaction (manualReviewAlertSent), not every run.
    if (!tx.manualReviewAlertSent && (now - createdMs) > MANUAL_REVIEW_AFTER_MS) {
      flaggedForReview++;
      await doc.ref.update({ manualReviewAlertSent: true });
      await emailAdmin(
        `⏳ Transaction stuck pending — needs manual check — ${tx.txRef || doc.id}`,
        `<p>Olives can't auto-confirm this transaction type (no verified Bigisub status endpoint for "${escapeHtml(tx.type)}" yet) and it's been pending for over 30 minutes.</p>
         <p>Ref: ${escapeHtml(tx.txRef || doc.id)}<br>Type: ${escapeHtml(tx.type)}<br>Amount: ₦${escapeHtml(tx.amount)}<br>User: ${escapeHtml(tx.userId)}</p>
         <p>Check the Bigisub dashboard directly, then use the "Change status" control in the admin Transactions tab.</p>`
      );
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, checked: pendingSnap.size, confirmedSuccess, confirmedFailed, flaggedForReview })
  };
};
