import { getStore } from '@netlify/blobs';
import { legacySubscriptionKey, subscriptionKey } from './lib/push.js';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    // New shape: { subscription, games:[...keys] }. Back-compat: a raw subscription.
    const subscription = body.subscription || body;
    const games = Array.isArray(body.games) ? body.games : [];
    const context = body.context || null;
    if (!subscription?.endpoint) {
      return new Response(JSON.stringify({ error: 'missing endpoint' }), { status: 400 });
    }
    const store = getStore('push-subscriptions');
    const key = subscriptionKey(subscription.endpoint);
    // Before keys were hashed, several devices could share one truncated key; adopt the record
    // stored there only when it really belongs to this endpoint.
    const legacyKey = legacySubscriptionKey(subscription.endpoint);
    const legacy = await store.get(legacyKey, { type:'json' }).catch(() => null);
    const ownsLegacy = (legacy?.subscription || legacy)?.endpoint === subscription.endpoint;
    const previous = await store.get(key, { type:'json' }).catch(() => null) || (ownsLegacy ? legacy : null);
    // Keep `watches` absent on a legacy record until the device sends a context; after that an
    // empty list means it follows nothing (not the default team).
    let watches = Array.isArray(previous?.watches) ? previous.watches : null;
    if (context?.teamKey && context?.seasonKey && context?.eventKey) {
      watches = (watches || []).filter(w => !(
        w.teamKey === context.teamKey && w.seasonKey === context.seasonKey
        && w.eventKey === context.eventKey
      ));
      watches.push(...games.map(gameKey => ({
        teamKey:context.teamKey, seasonKey:context.seasonKey,
        eventKey:context.eventKey, gameKey,
      })));
    }
    await store.setJSON(key, { subscription, games, ...(watches ? { watches } : {}), updatedAt:Date.now() });
    if (ownsLegacy) await store.delete(legacyKey).catch(() => {});
    return new Response(JSON.stringify({ ok:true, games:games.length, watches:watches?.length || 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

export const config = { path: '/subscribe' };
