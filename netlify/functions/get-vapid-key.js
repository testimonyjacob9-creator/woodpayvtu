// netlify/functions/get-vapid-key.js
// Returns the VAPID public key the server actually signs pushes with.
//
// Why this exists: index.html used to have its own hardcoded copy of the
// VAPID public key, separate from the one send-push.js reads from env vars.
// If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY were ever set in Netlify without
// also updating the hardcoded value in index.html, every subscription
// created after that point was signed with a public key that didn't match
// the private key the server pushes with — so every send failed for every
// user, silently.
//
// Fetching it from here instead means there is exactly one source of truth:
// whatever send-push.js uses is exactly what every client subscribes with.

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BJDn0ER_blc2Ga4onqhSEfEdO-GtO0QtrTwtW7BDDzNB-lMgeAJXUOh6xctoA5nqpit42hF4m1g8NK1XUuydmrQ';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({ publicKey: VAPID_PUBLIC })
  };
};
