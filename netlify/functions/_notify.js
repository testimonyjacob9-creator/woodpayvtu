// netlify/functions/_notify.js
// Writes a real, persistent notification to Firestore under
// users/{uid}/notifications/{auto-id}. This is what the in-app notification
// bell should actually be reading from (see index.html's notification
// center), instead of the old in-memory-only queue that reset on every
// page reload and only ever got filled by a live push message.
//
// Call this from any function that represents a real event the user should
// see in their notification history: wallet funding success/failure,
// admin wallet credit/debit, purchase success/failure, etc.

// Every automated notification is branded as coming from "Olives" — the
// name for WoodPay's automated backend assistant, visible to users so
// they can tell an automated message from a human admin broadcast (which
// passes from:'admin' to skip this prefix — see admin-notify.js).
async function notifyUser(admin, db, uid, { title, body, type = 'info', url = '/', from = 'olives' }) {
  if (!uid) return;
  const finalTitle = from === 'admin' ? title : `🫒 Olives — ${title}`;
  try {
    await db.collection('users').doc(uid).collection('notifications').add({
      title: finalTitle,
      body,
      type,       // 'info' | 'success' | 'warning' | 'danger'
      url,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    // Never let a notification write break the actual transaction flow.
    console.log('notifyUser failed:', e.message);
  }
}

module.exports = { notifyUser };
