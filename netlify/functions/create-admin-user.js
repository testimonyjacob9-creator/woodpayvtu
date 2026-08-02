// netlify/functions/create-admin-user.js
//
// Lets the owner create a new sub-admin login directly from the admin
// portal — no Firebase console needed. Creates the Firebase Auth account
// AND the admins/{uid} allowlist doc in one step.
//
// SECURITY: only an existing 'owner' may call this. The caller's idToken
// is verified, then their own admins/{uid} doc is checked for role==='owner'
// before anything is created. A subadmin (or anyone without an admins doc
// at all) is rejected.
//
// This endpoint can only ever create role:'subadmin' accounts — it
// deliberately has no path to create another 'owner', so it can't be used
// to self-escalate or hand out full access by mistake.
//
// Body: { idToken, email, password }
// Returns: { ok:true, uid } or { ok:false, error }

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

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

  const { idToken, email, password } = body;
  if (!idToken || !email || !password) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Missing required fields' }) };
  }
  if (String(password).length < 8) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Password must be at least 8 characters.' }) };
  }

  const db = admin.firestore();

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid or expired session. Please sign in again.' }) };
  }

  // Confirm the CALLER is an owner before creating anything.
  const callerSnap = await db.collection('admins').doc(decoded.uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== 'owner') {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Only the owner account can create sub-admin logins.' }) };
  }

  try {
    const newUser = await admin.auth().createUser({
      email: String(email).trim(),
      password: String(password),
      emailVerified: true
    });

    await db.collection('admins').doc(newUser.uid).set({
      role: 'subadmin',
      email: newUser.email,
      createdBy: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, uid: newUser.uid })
    };
  } catch (e) {
    console.error('create-admin-user error:', e.message);
    let msg = e.message;
    if (e.code === 'auth/email-already-exists') msg = 'That email is already registered.';
    if (e.code === 'auth/invalid-password') msg = 'Password must be at least 6 characters (Firebase minimum).';
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
