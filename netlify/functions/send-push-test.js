import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { VAPID_SUBJECT } from './lib/tournament.js';
import { legacySubscriptionKey, subscriptionKey } from './lib/push.js';

try {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} catch { /* test push is unavailable until VAPID is configured */ }

// Test harness, kept separate from real game push (`push-subscriptions`):
//   POST /send-push-test  → enroll the posted subscription (the page does this on ?test=1)
//   GET  /send-push-test  → push a test notification to every enrolled device
// Enrolled devices live in the `test-devices` blob store.
//
// If PUSH_TEST_SECRET is set, the GET trigger requires ?key=<secret>; if it's
// unset the trigger is open (only ever notifies devices that opted in via ?test=1).
export default async function handler(req) {
  // Whole harness is off unless explicitly enabled in Netlify env.
  if (process.env.ENABLE_PUSH_TESTS !== '1') {
    return json({ error: 'push tests disabled' }, 403);
  }

  const store = getStore('test-devices');

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null);
    const subscription = body?.subscription || body;
    if (!subscription?.endpoint) return json({ error: 'missing push subscription' }, 400);
    await store.setJSON(subscriptionKey(subscription.endpoint), subscription);
    // Drop this device's record under the older truncated key, if it owns that key.
    const legacyKey = legacySubscriptionKey(subscription.endpoint);
    const legacy = await store.get(legacyKey, { type: 'json' }).catch(() => null);
    if (legacy?.endpoint === subscription.endpoint) await store.delete(legacyKey).catch(() => {});
    const { blobs } = await store.list();
    return json({ ok: true, registered: true, devices: blobs.length });
  }

  const secret = process.env.PUSH_TEST_SECRET;
  if (secret) {
    const key = new URL(req.url).searchParams.get('key');
    if (key !== secret) return json({ error: 'forbidden' }, 403);
  }

  const { blobs } = await store.list();
  if (!blobs.length) {
    return json({ ok: true, sent: 0, note: 'No test devices. Open /?test=1 on a device first.' });
  }
  const entries = (await Promise.all(blobs.map(async b => ({ blobKey: b.key, sub: await store.get(b.key, { type: 'json' }) }))))
    .filter(e => e.sub);
  const subs = entries.map(e => e.sub);

  const payload = JSON.stringify({
    title: '🔔 Wicked push test',
    body: 'If you see this, notifications work on this device.',
    tag: 'test-push'
  });
  const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s, payload)));

  // Prune subscriptions the push service reports as gone.
  await Promise.all(results.map(async (r, i) => {
    const code = r.status === 'rejected' ? r.reason?.statusCode : null;
    if (code === 404 || code === 410) await store.delete(entries[i].blobKey).catch(() => {});
  }));

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const errors = results
    .filter(r => r.status === 'rejected')
    .map(r => r.reason?.statusCode || r.reason?.message);
  return json({ ok: true, devices: subs.length, sent, failed: errors.length, errors });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const config = { path: '/send-push-test' };
