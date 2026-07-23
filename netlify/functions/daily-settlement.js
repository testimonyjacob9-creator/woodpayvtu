// netlify/functions/daily-settlement.js
// Runs automatically once a day (see netlify.toml `schedule`) and pays
// Bigisub whatever WoodPay owes them for that period's successful orders.
//
// Netlify invokes scheduled functions internally with a special header —
// we check for it so this endpoint can't be triggered by an outside POST
// and move money on demand. Manual runs go through trigger-settlement.js
// instead, which requires admin login.

const { runSettlement } = require('./_settlementCore');

exports.handler = async (event) => {
  const isScheduledInvocation = event.headers && event.headers['x-netlify-event'] === 'schedule';
  if (!isScheduledInvocation) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'This endpoint only runs on Netlify\'s schedule. Use the admin panel to run settlement manually.' })
    };
  }

  try {
    const result = await runSettlement();
    console.log('daily-settlement result:', JSON.stringify(result));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (e) {
    console.error('daily-settlement error:', e.message);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
