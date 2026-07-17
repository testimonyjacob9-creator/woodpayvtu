// netlify/functions/_firebaseAdmin.js
//
// Shared Firebase Admin SDK initializer.
//
// admin.initializeApp() with no arguments relies on "Application Default
// Credentials" (ADC) — this only resolves automatically on Google Cloud
// infrastructure, where it reads from a local metadata server. Netlify
// Functions don't run on GCP, so that metadata server doesn't exist there.
// Critically, that lookup does NOT fail fast — it hangs until it times out
// (which is why every wallet-credit invocation was taking exactly 30000ms,
// Netlify's function timeout, before Netlify killed it and returned its own
// HTML error page instead of JSON — the "Unexpected token '<', DOCTYPE"
// error in the browser).
//
// Fix: build an explicit service-account credential from the
// FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env
// vars (already configured in Netlify site settings). If that credential
// can't be built (missing/malformed env vars), we deliberately do NOT fall
// back to admin.initializeApp() with no credential — that's the hang. We
// export an ADMIN_INIT_ERROR string instead, so every function can check it
// at the very top of its handler and return a fast, clear JSON error.
//
// Usage in a function file:
//   const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');
//
//   exports.handler = async (event) => {
//     if (ADMIN_INIT_ERROR) {
//       return { statusCode: 500, headers: {'Content-Type':'application/json'},
//                 body: JSON.stringify({ ok: false, error: ADMIN_INIT_ERROR }) };
//     }
//     const db = admin.firestore();
//     ...
//   };

const admin = require('firebase-admin');

let ADMIN_INIT_ERROR = null;

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Netlify env vars store the key with literal "\n" sequences instead of
  // real newlines, so they need to be converted back before use.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    ADMIN_INIT_ERROR = 'Server config error: Firebase Admin credentials missing (check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in Netlify env vars).';
    console.error(ADMIN_INIT_ERROR);
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey })
      });
    } catch (e) {
      // Malformed PEM key — cert() throws synchronously here, which is fine
      // (fast, not a hang). Record it instead of falling back to a no-arg
      // initializeApp(), which is what caused the 30s hangs.
      ADMIN_INIT_ERROR = 'Server config error: Firebase Admin credential rejected — check FIREBASE_PRIVATE_KEY formatting in Netlify env vars (must include full PEM header/footer and real newlines). Detail: ' + e.message;
      console.error(ADMIN_INIT_ERROR);
    }
  }
}

module.exports = { admin, ADMIN_INIT_ERROR };
