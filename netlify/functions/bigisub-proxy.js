// netlify/functions/bigisub-proxy.js
// Proxies calls to the Bigisub VTU API.
// The BIGISUB_TOKEN env var lives only here — never exposed to the browser.
//
// Body: { path: string, method: 'GET'|'POST', body?: object }
// Returns: Bigisub JSON response merged with { httpOk, timeout? }

const BIGISUB_BASE = 'https://api.bigisub.ng/';
const TOKEN = process.env.BIGISUB_TOKEN || '';
const PIN = process.env.BIGISUB_PIN || '';
const TIMEOUT_MS = 9000; // 9 s — leaves 1 s buffer before Netlify's 10 s limit

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let req;
  try { req = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { path, method = 'GET', body: reqBody } = req;
  if (!path) return { statusCode: 400, body: JSON.stringify({ error: 'Missing path' }) };

  if (!TOKEN) {
    console.error('BIGISUB_TOKEN env var is not set');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, httpOk: false, error: 'API token not configured' })
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = BIGISUB_BASE + path;
    // Server-side PIN injection: purchase/verify endpoints require Bigisub's
    // transaction PIN. It never comes from the browser — always injected here.
    let outBody = reqBody;
    if (method === 'POST' && reqBody && PIN) {
      outBody = { ...reqBody, pin: PIN };
    }
    const fetchOpts = {
      method,
      headers: {
        'Authorization': `Token ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    };
    if (method === 'POST' && outBody) {
      fetchOpts.body = JSON.stringify(outBody);
    }

    const res = await fetch(url, fetchOpts);
    let data = {};
    try { data = await res.json(); } catch (_) {}

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ httpOk: res.ok, ...data })
    };
  } catch (e) {
    if (e.name === 'AbortError') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ httpOk: false, timeout: true, success: false })
      };
    }
    console.error('bigisub-proxy fetch error:', e.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ httpOk: false, success: false, error: e.message })
    };
  } finally {
    clearTimeout(timer);
  }
};
