// netlify/functions/_settlementCore.js
//
// Core logic for paying Bigisub what WoodPay owes them, once a day.
//
// Model (confirmed with the business owner):
//   - User funds wallet (e.g. ₦500) -> stays in Flutterwave, nothing owed yet.
//   - User buys an item (e.g. ₦330). Bigisub's cost for that order (e.g. ₦320)
//     is stored on the transaction doc as `buyPrice`. That ₦320 is what
//     WoodPay owes Bigisub. The ₦10 spread is WoodPay's margin and is never
//     moved — it just stays in the Flutterwave balance.
//   - Once a day, this sums `buyPrice` across every *unsettled, successful*
//     order and sends ONE transfer for that total to Bigisub's bank account.
//
// Only transactions with a numeric buyPrice are eligible — wallet-funding
// records (written by wallet-credit.js) never carry buyPrice, so they're
// naturally excluded without any extra filtering logic.
//
// Idempotency: each eligible transaction is marked `settled: true` in the
// SAME Firestore batch that records the settlement. If this function is
// invoked twice (cron overlap, retry after a timeout, manual trigger right
// after a scheduled run), already-settled transactions are simply skipped,
// so Bigisub is never paid twice for the same order.

const { admin, ADMIN_INIT_ERROR } = require('./_firebaseAdmin');

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || '';
const BIGISUB_ACCOUNT_NUMBER = process.env.BIGISUB_ACCOUNT_NUMBER || '';
// Flutterwave NUBAN code. Defaults to Sterling Bank (232) since that's the
// account on file, but stays overridable via env var if that ever changes.
const BIGISUB_BANK_CODE = process.env.BIGISUB_BANK_CODE || '232';
// Optional: if set, the resolved account name from Flutterwave must contain
// this (case-insensitive) or the run aborts instead of paying a stranger.
const BIGISUB_ACCOUNT_NAME_HINT = process.env.BIGISUB_ACCOUNT_NAME_HINT || '';

// Flutterwave requires IP whitelisting for the Transfers API (mandatory,
// can't be turned off on their end). Netlify Functions don't have a fixed
// outbound IP — it rotates — so whitelisting one IP directly will randomly
// break later. If STATIC_IP_PROXY_URL is set (e.g. from a service like
// QuotaGuard Static IP), route Flutterwave calls through it so Flutterwave
// always sees the same, whitelistable IP. Leave the env var unset and this
// is a no-op — calls go out directly as before.
const STATIC_IP_PROXY_URL = process.env.STATIC_IP_PROXY_URL || '';
let proxyDispatcher = null;
if (STATIC_IP_PROXY_URL) {
  try {
    const { ProxyAgent } = require('undici');
    proxyDispatcher = new ProxyAgent(STATIC_IP_PROXY_URL);
  } catch (e) {
    console.error('STATIC_IP_PROXY_URL is set but the "undici" package is not installed. Add "undici" to netlify/functions/package.json dependencies.');
  }
}
function flwFetch(url, opts) {
  return fetch(url, proxyDispatcher ? { ...opts, dispatcher: proxyDispatcher } : opts);
}

function genBatchRef() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const rand = Math.random().toString(36).slice(2, 8);
  return `SETTLE-${stamp}-${rand}`;
}

async function resolveBigisubAccount() {
  const res = await flwFetch('https://api.flutterwave.com/v3/accounts/resolve', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FLW_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      account_number: BIGISUB_ACCOUNT_NUMBER,
      account_bank: BIGISUB_BANK_CODE
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 'success') {
    throw new Error('Could not resolve Bigisub account with Flutterwave: ' + (data.message || res.status));
  }
  return data.data; // { account_number, account_name }
}

async function getSettlementConfig(db) {
  const snap = await db.collection('settings').doc('settlement').get();
  const data = snap.exists ? snap.data() : {};
  const intervalDays = Number(data.intervalDays) > 0 ? Number(data.intervalDays) : 1;
  return { intervalDays };
}

async function getLastSuccessfulSettlement(db) {
  const snap = await db.collection('settlements')
    .where('status', '==', 'success')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  return { id: doc.id, createdAt: data.createdAt ? data.createdAt.toDate() : null };
}

async function runSettlement({ dryRun = false, force = false } = {}) {
  if (ADMIN_INIT_ERROR) throw new Error(ADMIN_INIT_ERROR);
  if (!FLW_SECRET_KEY) throw new Error('FLW_SECRET_KEY env var is not set.');
  if (!BIGISUB_ACCOUNT_NUMBER) throw new Error('BIGISUB_ACCOUNT_NUMBER env var is not set.');

  const db = admin.firestore();

  // 0. Respect the admin-configured payout cadence (daily / every 2 days /
  //    weekly, set from admin.html — no redeploy needed to change it). The
  //    scheduled function still runs every day to check, but only actually
  //    pays out once the interval has elapsed since the last successful run.
  //    Previews (dryRun) and an explicit manual override (force) skip this
  //    gate so the admin can always see what's pending or force a payout.
  const { intervalDays } = await getSettlementConfig(db);
  if (!dryRun && !force) {
    const last = await getLastSuccessfulSettlement(db);
    if (last && last.createdAt) {
      const dueAt = new Date(last.createdAt.getTime() + intervalDays * 86400000);
      if (new Date() < dueAt) {
        return {
          ok: true,
          skipped: true,
          reason: `Not due yet — next settlement due ${dueAt.toISOString()} (every ${intervalDays} day${intervalDays === 1 ? '' : 's'}).`,
          intervalDays,
          nextDueAt: dueAt.toISOString(),
          total: 0,
          count: 0
        };
      }
    }
  }

  // 1. Pull every successful, not-yet-settled transaction that has a
  //    Bigisub cost attached. Firestore can't query "field missing" well,
  //    so we filter `settled !== true` in JS after fetching by status.
  const snap = await db.collection('transactions').where('status', '==', 'success').get();

  const eligible = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (d.settled === true) return;
    if (typeof d.buyPrice !== 'number' || d.buyPrice <= 0) return; // e.g. wallet_funding docs
    eligible.push({ id: doc.id, buyPrice: d.buyPrice, txRef: d.txRef || doc.id });
  });

  const total = eligible.reduce((sum, t) => sum + t.buyPrice, 0);

  if (eligible.length === 0 || total <= 0) {
    return { ok: true, skipped: true, reason: 'Nothing to settle.', intervalDays, total: 0, count: 0 };
  }

  // 2. Sanity-check the destination account before moving money.
  const resolved = await resolveBigisubAccount();
  if (
    BIGISUB_ACCOUNT_NAME_HINT &&
    !String(resolved.account_name || '').toLowerCase().includes(BIGISUB_ACCOUNT_NAME_HINT.toLowerCase())
  ) {
    throw new Error(
      `Resolved account name "${resolved.account_name}" does not match expected name hint "${BIGISUB_ACCOUNT_NAME_HINT}". Aborting to avoid paying the wrong account.`
    );
  }

  const batchRef = genBatchRef();

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      total,
      count: eligible.length,
      resolvedAccountName: resolved.account_name,
      intervalDays,
      batchRef
    };
  }

  // 3. Initiate the transfer.
  const transferRes = await flwFetch('https://api.flutterwave.com/v3/transfers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FLW_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      account_bank: BIGISUB_BANK_CODE,
      account_number: BIGISUB_ACCOUNT_NUMBER,
      amount: total,
      currency: 'NGN',
      reference: batchRef,
      narration: `WoodPay -> Bigisub daily settlement (${eligible.length} orders)`
    })
  });
  const transferData = await transferRes.json().catch(() => ({}));

  if (!transferRes.ok || transferData.status !== 'success') {
    // Record the failed attempt so it shows up in the admin history, but do
    // NOT mark transactions settled — they must be retried next run.
    await db.collection('settlements').add({
      batchRef,
      total,
      count: eligible.length,
      status: 'failed',
      error: transferData.message || `HTTP ${transferRes.status}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    throw new Error('Flutterwave transfer failed: ' + (transferData.message || transferRes.status));
  }

  // 4. Mark every included transaction settled + record the settlement,
  //    all in one batch so a crash mid-way can't leave things inconsistent.
  //    Firestore batches cap at 500 writes; chunk if needed.
  const CHUNK = 400;
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const chunk = eligible.slice(i, i + CHUNK);
    const batch = db.batch();
    chunk.forEach((t) => {
      batch.update(db.collection('transactions').doc(t.id), {
        settled: true,
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
        settlementBatchRef: batchRef
      });
    });
    await batch.commit();
  }

  await db.collection('settlements').add({
    batchRef,
    total,
    count: eligible.length,
    status: 'success',
    flwTransferId: transferData.data && transferData.data.id ? transferData.data.id : null,
    flwStatus: transferData.data && transferData.data.status ? transferData.data.status : null,
    resolvedAccountName: resolved.account_name,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    ok: true,
    total,
    count: eligible.length,
    batchRef,
    resolvedAccountName: resolved.account_name,
    flwTransferId: transferData.data ? transferData.data.id : null,
    intervalDays
  };
}

// One-time (or occasional) reset: mark every currently-unsettled successful
// order as settled WITHOUT sending any money. Use this once, right after
// turning the settlement system on, to clear out old orders that were
// already paid to Bigisub some other way before this system existed — so
// the running total only reflects NEW orders from this point forward.
async function markBaseline() {
  if (ADMIN_INIT_ERROR) throw new Error(ADMIN_INIT_ERROR);
  const db = admin.firestore();

  const snap = await db.collection('transactions').where('status', '==', 'success').get();
  const eligible = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (d.settled === true) return;
    if (typeof d.buyPrice !== 'number' || d.buyPrice <= 0) return;
    eligible.push({ id: doc.id, buyPrice: d.buyPrice });
  });

  if (eligible.length === 0) {
    return { ok: true, count: 0, total: 0, reason: 'Nothing to reset — already at zero.' };
  }

  const total = eligible.reduce((s, t) => s + t.buyPrice, 0);
  const batchRef = 'BASELINE-' + genBatchRef();

  const CHUNK = 400;
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const chunk = eligible.slice(i, i + CHUNK);
    const batch = db.batch();
    chunk.forEach((t) => {
      batch.update(db.collection('transactions').doc(t.id), {
        settled: true,
        settledAt: admin.firestore.FieldValue.serverTimestamp(),
        settlementBatchRef: batchRef,
        settledViaBaseline: true // flags this wasn't an actual payout
      });
    });
    await batch.commit();
  }

  // Recorded with status 'baseline' (not 'success') so it never counts as a
  // real payout for the auto-payout due-date calculation.
  await db.collection('settlements').add({
    batchRef,
    total,
    count: eligible.length,
    status: 'baseline',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true, count: eligible.length, total, batchRef };
}

module.exports = { runSettlement, markBaseline };
