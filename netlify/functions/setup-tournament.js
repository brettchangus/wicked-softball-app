// GET /setup-tournament?event={publicEventId}&key={SETUP_SECRET}
// Auto-discovers a tournament's structure (division, pools, teams, schedule, brackets,
// venue, dates) from its public event id and writes the L1 structure blob. Run once when
// switching events (the check-scores cron also self-triggers this when PUBLIC_EVENT_ID
// changes). SETUP_SECRET is required and locks the trigger behind ?key=.
import { buildProviderStructure } from './lib/providers.js';
import { contextInputFromRequest, resolveContext, readStructure, writeStructure } from './lib/snapshot.js';
import { effectiveSelection } from './lib/context.js';

export default async function handler(req) {
  const url = new URL(req.url);
  const secret = process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) return json({ error: 'forbidden' }, 403);
  try {
    const context = await resolveContext(contextInputFromRequest(req));
    const eventId = url.searchParams.get('event') || context.eventId;
    if (eventId !== context.eventId) {
      return json({ error:'use the admin switch-event action to assign a different provider event and stable event key' }, 409);
    }
    const s = await buildProviderStructure(eventId, context.team, { providerTeamId: context.event?.providerTeamId,
      previousStructure:await readStructure(eventId, context.scope), selection:effectiveSelection(context.event) });
    await writeStructure(eventId, s, context.scope);
    return json({
      ok: true, eventId, name: s.meta.name, division: s.meta.division,
      bracketDate: s.meta.bracketDate, venue: s.meta.venue,
      pools: s.poolOrder.map(k => `${k}:${s.pools[k].teams.length}t`),
      brackets: s.brackets.map(b => `${b.level}:${b.size}`),
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/setup-tournament' };
