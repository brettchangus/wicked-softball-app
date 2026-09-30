// Admin push to ALL subscribers (the push-subscriptions store).
//   Custom message:  GET /notify?key=<secret>&title=Schedule%20is%20up&body=Check%20it%20out
//   Force a refresh:  GET /notify?key=<secret>&refresh=1          (reloads open tabs)
//   Both:             GET /notify?key=<secret>&title=...&body=...&refresh=1
// Also accepts a POST JSON body ({title, body, refresh, url, tag}) for longer text.
// Locked behind NOTIFY_SECRET (falls back to SETUP_SECRET); fail closed if unset. The admin
// page's broadcast form uses ADMIN_SECRET (falling back to SETUP_SECRET), also accepted here.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { VAPID_SUBJECT } from './lib/tournament.js';
import { bumpRev, contextInputFromRequest, resolveContext } from './lib/snapshot.js';
import { isLegacySubscription } from './lib/push.js';

try {
  webpush.setVapidDetails(VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
} catch { /* notification delivery is unavailable until VAPID is configured */ }

export default async function handler(req) {
  const url = new URL(req.url);
  const secrets = [process.env.NOTIFY_SECRET || process.env.SETUP_SECRET,
    process.env.ADMIN_SECRET || process.env.SETUP_SECRET].filter(Boolean);
  if (!secrets.includes(url.searchParams.get('key'))) return json({ error: 'forbidden' }, 403);
  let context;
  try {
    context = await resolveContext(contextInputFromRequest(req));
  } catch (error) {
    return json({ error: error.message }, 404);
  }

  let p = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') { try { p = { ...p, ...(await req.json()) }; } catch {} }
  const refresh = [true, 1, '1', 'true'].includes(p.refresh);
  if (!p.title && !refresh) return json({ error: 'provide ?title=… (and optional &body=…), or &refresh=1' }, 400);

  // Bump the global rev too, so even open tabs that aren't subscribed reload on their
  // next poll (the push's postMessage handles subscribed tabs instantly).
  if (refresh) await bumpRev(context.scope);

  const payload = JSON.stringify({
    title: p.title || context.team.shortName || context.team.name,
    body: p.body || (refresh ? 'Refreshing to the latest…' : ''),
    tag: p.tag || (refresh ? `${context.teamKey}-refresh` : `${context.teamKey}-note`),
    url: p.url || `/teams/${context.teamKey}/seasons/${context.seasonKey}`,
    refresh,
  });

  const store = getStore('push-subscriptions');
  const { blobs } = await store.list();
  const records = (await Promise.all(blobs.map(async b => ({ blobKey:b.key, record:await store.get(b.key, { type:'json' }) }))))
    .filter(r => r.record);
  const subs = records.filter(({ record }) => {
    if (isLegacySubscription(record))
      return context.teamKey === context.catalog.defaultTeamKey; // legacy subscriptions belong to the original team
    return record.watches.some(w => w.teamKey === context.teamKey && w.seasonKey === context.seasonKey);
  }).map(({ blobKey, record }) => ({ blobKey, sub:record.subscription || record }));
  if (!subs.length) return json({ ok: true, sent: 0, note: 'no subscribers yet' });

  const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(s.sub, payload)));
  // Prune subscriptions the push service reports as gone, by the key each was read from.
  await Promise.all(results.map(async (r, i) => {
    const code = r.status === 'rejected' ? r.reason?.statusCode : null;
    if (code === 404 || code === 410) await store.delete(subs[i].blobKey).catch(() => {});
  }));

  const sent = results.filter(r => r.status === 'fulfilled').length;
  return json({ ok: true, devices: subs.length, sent, failed: results.length - sent, refresh, title: JSON.parse(payload).title });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/notify' };
