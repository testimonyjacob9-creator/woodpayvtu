// netlify/functions/send-push.js
// Sends Web Push notifications to one or more subscriptions.
// Uses the `web-push` npm package — install it in Netlify via package.json.
//
// Body: {
//   title, body, url?,
//   subscriptions: [{endpoint, keys:{p256dh, auth}, userEmail?}],
//   notificationType?: 'info'|'success'|'warning'|'danger'
// }

const webpush = require('web-push');

// Prefer env vars (set in Netlify → Environment variables); fall back to the
// original hardcoded values so nothing breaks if they're not set yet.
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BJDn0ER_blc2Ga4onqhSEfEdO-GtO0QtrTwtW7BDDzNB-lMgeAJXUOh6xctoA5nqpit42hF4m1g8NK1XUuydmrQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'RVpf4kLdZCWo_BkdSYa3WzBfixIRRHO_NOERvMdqVZA';
const VAPID_SUBJECT = 'mailto:vtusurpport@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// Don't keep TCP sockets alive after each push — that's what was causing
// the function to hang until the platform timeout (30s) instead of
// returning as soon as the work was actually done.
const pushOptions = { TTL: 60, agent: new (require('https').Agent)({ keepAlive: false }) };

function sendWithTimeout(sub, payload, ms = 8000) {
  return Promise.race([
    webpush.sendNotification(sub, payload, pushOptions),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Push timed out')), ms))
  ]);
}

exports.handler = async (event, context) => {
  // Let the function return as soon as we're done, instead of waiting for
  // the Node event loop to fully drain (which was the root cause of the
  // 30s hangs / HTML timeout pages you were seeing).
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    title = 'WoodPay',
    body: msgBody = '',
    url = '/',
    subscriptions = [],
    notificationType = 'info'
  } = body;

  if (!subscriptions.length) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'No subscriptions provided' })
    };
  }

  const payload = JSON.stringify({ title, body: msgBody, url, notificationType });

  let sent = 0, failed = 0;
  const results = [];

  for (const sub of subscriptions) {
    try {
      await sendWithTimeout(sub, payload);
      sent++;
      results.push({ email: sub.userEmail || '—', status: 'sent' });
    } catch (e) {
      // 410 Gone = subscription expired/unsubscribed — not a real error
      if (e.statusCode === 410) {
        sent++;
        results.push({ email: sub.userEmail || '—', status: 'expired' });
      } else {
        failed++;
        results.push({ email: sub.userEmail || '—', status: 'failed', error: e.message });
        console.error('Push failed for', sub.userEmail, ':', e.message);
      }
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      sent,
      failed,
      total: subscriptions.length,
      successRate: Math.round((sent / subscriptions.length) * 100),
      message: `Sent ${sent}/${subscriptions.length} notifications.`,
      details: results.slice(0, 10)
    })
  };
};
