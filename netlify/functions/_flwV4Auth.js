// netlify/functions/_flwV4Auth.js
//
// Shared OAuth 2.0 token helper for Flutterwave v4 API.
//
// v4 doesn't use a static secret key on every request like v3 did — instead
// you exchange FLW_CLIENT_ID + FLW_CLIENT_SECRET for a short-lived access
// token (10 minutes), then send that as a Bearer token on API calls.
//
// Netlify Functions are stateless/cold-started per invocation, so we can't
// rely on an in-memory cache surviving between calls the way a long-running
// server could. Instead we just fetch a fresh token every time a function
// needs one — a single token request is cheap and avoids the complexity
// (and failure mode) of a token expiring mid-request in a serverless
// environment. If this becomes a real cost/latency concern at higher
// volume, this is the file to add caching to.

const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID || '';
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET || '';
const TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

async function getFlwV4Token() {
  if (!FLW_CLIENT_ID || !FLW_CLIENT_SECRET) {
    throw new Error('FLW_CLIENT_ID / FLW_CLIENT_SECRET env vars are not set.');
  }

  const params = new URLSearchParams();
  params.append('client_id', FLW_CLIENT_ID);
  params.append('client_secret', FLW_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    console.error('flw v4 token error:', data);
    throw new Error(data.error_description || 'Could not authenticate with Flutterwave v4.');
  }

  return data.access_token;
}

module.exports = { getFlwV4Token };
