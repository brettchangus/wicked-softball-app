// GET /refresh?key=<secret> — silent force-refresh, NO notification.
// Bumps the global snapshot `rev`; every open tab notices the change on its next
// ~60s poll and reloads itself (picking up the latest app + data). Closed apps just
// get it whenever they're next opened. Locked behind NOTIFY_SECRET (falls back to
// SETUP_SECRET). For an instant refresh that also reaches backgrounded apps, use
// /notify?refresh=1 instead (that one shows a notification, as web push requires).
import { bumpRev, contextInputFromRequest, resolveContext } from './lib/snapshot.js';

export default async function handler(req) {
  const url = new URL(req.url);
  const secret = process.env.NOTIFY_SECRET || process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) {
    return json({ error: 'forbidden' }, 403);
  }
  let context;
  try {
    context = await resolveContext(contextInputFromRequest(req));
  } catch (error) {
    return json({ error: error.message }, 404);
  }
  const rev = await bumpRev(context.scope);
  return json({ ok: true, rev, note: 'open tabs will reload within ~60s (no notification sent)' });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/refresh' };
