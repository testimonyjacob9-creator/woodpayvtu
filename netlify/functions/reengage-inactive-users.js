// netlify/functions/reengage-inactive-users.js
//
// Scheduled job (see netlify.toml) — runs automatically, no admin action
// needed. Finds users who haven't transacted in 2+ days and sends them a
// low-key "come back" email + in-app notification reminding them of their
// wallet balance and what they can do with WoodPay.
//
// WHY DAILY CRON + PER-USER GATING INSTEAD OF A "RUN EVERY 2 DAYS" CRON:
// Standard cron can't express "every 2 days starting from whenever each
// user went inactive" — a `*/2` day-of-month field just means odd
// calendar days, which drifts out of sync with each user's own inactivity
// clock. Instead this runs once a day, and gates who actually gets
// messaged with lastReengagementSentAt so any single user is still only
// ever messaged about once every 2 days, measured from their own activity.
//
// Activity tracking: users.lastActivityAt is stamped by processDelivery()
// in index.html (any purchase attempt) and by flw-v3-webhook.js (wallet
// funding) — see those files. Users who've never transacted at all use
// their account createdAt as the baseline instead.
//
// Loads the whole users collection into memory and filters — same pattern
// admin.html already uses for ALL_USERS. Fine at this app's scale; if the
// user base grows into the tens of thousands this should move to a
// Firestore query with a composite index on lastActivityAt instead.

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
const { notifyUser } = require('./_notify');

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || '';
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 15;

function naira(n) {
  return Number(n || 0).toLocaleString('en-NG');
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds != null) return ts._seconds * 1000;
  return null;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendReengagementEmail(user) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL || !user.email) return { ok: false, skipped: true };

  const firstName = escapeHtml((user.name || 'there').trim().split(' ')[0] || 'there');
  const balance = naira(user.walletBalance);

  // Deliberately understated and personal in tone (no discount codes, no
  // "LIMITED TIME", no exclamation-heavy copy) — this is meant to read
  // like a normal transactional/account email, which keeps it out of
  // Gmail's Promotions tab and spam filters far more reliably than a
  // marketing-styled blast would.
  const html = `
<div style="background:#f0f0f0;padding:20px;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#1a7a4a 0%,#0d5c35 100%);padding:32px 36px;text-align:center;">
      <div style="color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-1px;">Wood<span style="color:#7fffb8;">Pay</span></div>
    </div>
    <div style="padding:36px;">
      <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">Hi ${firstName},</p>
      <p style="color:#444;font-size:15px;line-height:1.7;margin:0 0 15px;">It's been a couple of days since your last order, so here's a quick reminder of where your account stands.</p>
      <div style="background:#f7fbf9;border:1px solid #e3f0e8;border-radius:10px;padding:18px 20px;margin:20px 0;">
        <div style="font-size:12px;color:#1a7a4a;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Wallet balance</div>
        <div style="font-size:26px;color:#111;font-weight:800;margin-top:4px;">₦${balance}</div>
      </div>
      <p style="color:#444;font-size:14.5px;line-height:1.7;margin:0 0 15px;">You can use it any time for data, airtime, TV subscriptions, or electricity — funding is instant and it's usually cheaper than paying full price elsewhere.</p>
      <a href="https://woodpay.netlify.app" style="display:inline-block;background:#1a7a4a;color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:8px;font-weight:700;font-size:14.5px;margin:6px 0 4px;">Open WoodPay →</a>
    </div>
    <div style="background:#f7f7f7;padding:22px 36px;text-align:center;">
      <p style="font-size:11.5px;color:#999;line-height:1.7;margin:0;">Sent automatically by Olives, WoodPay's account assistant.<br>© 2026 WoodPay. You're receiving this because you have a WoodPay account.</p>
    </div>
  </div>
</div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Olives from WoodPay', email: BREVO_SENDER_EMAIL },
        to: [{ email: user.email }],
        subject: `Your WoodPay balance: ₦${balance}`,
        htmlContent: html
      })
    });
    return { ok: res.ok };
  } catch (e) {
    console.log('reengage: email send failed for', user.email, e.message);
    return { ok: false, reason: e.message };
  }
}

exports.handler = async () => {
  if (ADMIN_INIT_ERROR) {
    console.error('reengage-inactive-users: Firebase not initialized:', ADMIN_INIT_ERROR);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
  }

  const db = admin.firestore();
  const now = Date.now();
  const cutoff = now - TWO_DAYS_MS;

  let usersSnap;
  try {
    usersSnap = await db.collection('users').get();
  } catch (e) {
    console.error('reengage-inactive-users: could not load users:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }

  const candidates = [];
  usersSnap.forEach((doc) => {
    const u = doc.data();
    if (u.blocked) return;
    if (!u.email) return;

    const createdAtMs = toMillis(u.createdAt);
    // Account itself must be at least 2 days old — brand-new signups are
    // "new users" (a separate welcome flow), not "old inactive users".
    if (createdAtMs && createdAtMs > cutoff) return;

    const lastActivityMs = toMillis(u.lastActivityAt) || createdAtMs;
    if (lastActivityMs && lastActivityMs > cutoff) return; // active recently — skip

    const lastSentMs = toMillis(u.lastReengagementSentAt);
    if (lastSentMs && lastSentMs > cutoff) return; // already nudged within 2 days

    candidates.push({ id: doc.id, ...u });
  });

  console.log(`reengage-inactive-users: ${candidates.length} inactive user(s) out of ${usersSnap.size} total`);

  let sent = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (user) => {
      const emailResult = await sendReengagementEmail(user);
      await notifyUser(admin, db, user.id, {
        title: 'We miss you 👋',
        body: `Your WoodPay wallet has ₦${naira(user.walletBalance)}. Top up data, airtime, TV or electricity any time.`,
        type: 'info',
        url: '/'
      });
      try {
        await db.collection('users').doc(user.id).update({
          lastReengagementSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.log('reengage: could not stamp lastReengagementSentAt for', user.id, e.message);
      }
      if (emailResult.ok) sent++;
    }));
  }

  console.log(`reengage-inactive-users: done — ${sent} email(s) sent, ${candidates.length} notified in-app`);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, checked: usersSnap.size, matched: candidates.length, emailsSent: sent })
  };
};
