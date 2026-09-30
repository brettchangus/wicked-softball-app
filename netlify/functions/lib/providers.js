import { MY_ID, AGE_PREFIX, SETUP_VERSION, DEFAULT_TEAM_KEY, TOURNEY_MACHINE_TOURNAMENT_ID, TOURNEY_MACHINE_DIVISION_ID, TOURNEY_MACHINE_TEAM_ID } from './tournament.js';
import { buildStructure as buildNorcalStructure, detectNorcalEvent, geocode } from './norcal.js';
import { buildAstStructure, parseAstRef, detectAstEvent } from './ast.js';
import { buildTourneyMachineStructure, preserveTourneyMachineTopology, detectTourneyMachineEvent } from './tourneymachine.js';
import { selectionHash } from './context.js';

// `providerTeamIdHint` lets a caller that already knows an event's provider-side team id (e.g.
// the stored `event.providerTeamId` from season.events) supply it for a 2-part `tm:` ref that
// doesn't embed one — without this, re-discovery for any non-default Tourney Machine event would
// throw on every call (cron, re-run setup, pull scores) even though the id was already resolved
// once and recorded on the event.
export function parseEventRef(value, team = {}, providerTeamIdHint = null, selection = null) {
  const id = String(value || '').trim();
  // A saved AST discovery.manual correction (docs/tournament-setup-plan.md) overrides the team's
  // own astRegion/astTeamName defaults — per-tournament, since a team could reasonably be listed
  // under a slightly different exact roster name at different events.
  if (/^https:\/\/(?:www\.)?allstartournaments\.com\//i.test(id)) return parseAstRef(id, {
    ...team,
    astRegion: selection?.region || team.astRegion,
    astTeamName: selection?.teamName || team.astTeamName,
    // The detected (or corrected) team-list age wins over the team's Age fallback.
    agePrefix: selection?.age != null ? String(selection.age) : team.agePrefix,
  });
  const tm = id.match(/^tm:([^:]+):([^:]+)(?::([^:]+))?$/);
  if (tm) {
    const configured = (!team.key || team.key === DEFAULT_TEAM_KEY)
      && tm[1] === TOURNEY_MACHINE_TOURNAMENT_ID && tm[2] === TOURNEY_MACHINE_DIVISION_ID;
    const providerTeamId = tm[3] || providerTeamIdHint || (configured ? TOURNEY_MACHINE_TEAM_ID : null);
    if (!providerTeamId) throw new Error('a different Tourney Machine event requires tm:<tournament-id>:<division-id>:<provider-team-id>');
    return { key:id, provider:'tourneymachine', tournamentId:tm[1], divisionId:tm[2], providerTeamId };
  }
  if (/^\d+$/.test(id)) {
    const isDefaultTeam = !team.key || team.key === DEFAULT_TEAM_KEY;
    const providerTeamId = team.norcalTeamId || (isDefaultTeam ? MY_ID : null);
    if (!providerTeamId) throw new Error(`team "${team.key}" has no norcalTeamId configured`);
    return { key:id, provider:'norcal', eventId:id, providerTeamId };
  }
  throw new Error('event must be an AST event URL, NorCal numeric id or tm:<tournament-id>:<division-id>[:<provider-team-id>]');
}

// `selection` (docs/tournament-setup-plan.md Phase 1) is the merged detected+manual pick from
// an event's `discovery` block (see context.js effectiveSelection) — {divisionIds,
// sisterDivisionIds, providerTeamId, region, teamName}. NorCal honors divisionIds/
// sisterDivisionIds (which real divisions to fetch); Tourney Machine's divisionId/providerTeamId
// are resolved into the providerRef itself at save time (see admin.js's saveEvent) rather than
// applied here, so selection.providerTeamId is what actually reaches it, via parseEventRef's
// providerTeamIdHint fallback; AST honors region/teamName (overriding the team's own astRegion/
// astTeamName defaults). An event with no discovery block passes `undefined`, which behaves
// exactly as before (age-prefix division matching, team-level AST region/name defaults).
export async function buildProviderStructure(eventRef, team = {}, { providerTeamId: providerTeamIdHint = null, previousStructure = null, selection = null } = {}) {
  const isDefaultTeam = !team.key || team.key === DEFAULT_TEAM_KEY;
  const canonicalTeamId = team.norcalTeamId || (isDefaultTeam ? MY_ID : null);
  if (!canonicalTeamId) throw new Error(`team "${team.key}" has no norcalTeamId configured`);
  const ref = parseEventRef(eventRef, team, providerTeamIdHint || selection?.providerTeamId, selection);
  const divisionIds = ref.provider === 'norcal' && selection?.divisionIds?.length
    ? [...new Set([...selection.divisionIds, ...(selection.sisterDivisionIds || [])])]
    : null;
  const structure = ref.provider === 'ast'
    ? await buildAstStructure(ref, { canonicalTeamId })
    : ref.provider === 'tourneymachine'
    ? await buildTourneyMachineStructure(ref, { canonicalTeamId })
    : await buildNorcalStructure(ref.eventId, {
        myId:canonicalTeamId, agePrefix:team.agePrefix || AGE_PREFIX, divisionIds,
        geocodeFn:reuseVenueCoords(previousStructure),
      });
  if (ref.provider !== 'ast') structure.meta.provider = ref.provider;
  structure.meta.providerTeamId = structure.meta.providerTeamId || ref.providerTeamId;
  if (ref.provider === 'tourneymachine') structure.meta.sourceProviderTeamId = ref.providerTeamId;
  structure.meta.norcalTeamId = canonicalTeamId;
  structure.meta.setupVersion = SETUP_VERSION;
  structure.meta.selectionHash = selectionHash(selection);
  return preserveTourneyMachineTopology(previousStructure, structure);
}

// Re-exported for admin.js/detect callers — kept alongside buildProviderStructure so the "detect"
// and "build" halves of docs/tournament-setup-plan.md's flow live behind one import. Each
// provider's detect() has its own shape (documented at its definition); admin.js's detectEvent
// action picks which one to call from the input's own shape (a NorCal id/URL, an AST URL, or a
// Tourney Machine tournament/division URL/ref).
export { detectNorcalEvent, detectTourneyMachineEvent, detectAstEvent };

// A rebuild of the same NorCal facility reuses the stored coordinates instead of geocoding again,
// so the hourly schedule refresh never turns into an hourly Nominatim lookup.
function reuseVenueCoords(previousStructure) {
  const venue = previousStructure?.meta?.venue;
  return facility => venue?.name && venue.name === facility?.name && venue.lat != null && venue.lon != null
    ? { lat:venue.lat, lon:venue.lon }
    : geocode(facility);
}

// Diff two structures' schedules by stable game key: added/removed games, and games whose time,
// field, or matchup changed. Removed + added together means the provider renumbered games.
export function structureChanges(oldStructure, nextStructure) {
  const collect = s => [
    ...Object.entries(s?.pools || {}).flatMap(([pool, p]) => (p.games || []).map(g => [g.key || `pool:${pool}:${g.gameNo}`, g])),
    ...(s?.brackets || []).flatMap(b => (b.frame || []).map(g => [g.key || `bracket:${b.level}:${g.gameNo}`, g])),
  ];
  const oldGames = new Map(collect(oldStructure));
  const nextGames = new Map(collect(nextStructure));
  const added = [...nextGames.keys()].filter(k => !oldGames.has(k));
  const removed = [...oldGames.keys()].filter(k => !nextGames.has(k));
  const changed = [...nextGames].filter(([k,g]) => oldGames.has(k) && ['time','fac','field','topId','botId','topName','botName','hid','aid','hn','an'].some(x => JSON.stringify(oldGames.get(k)[x]) !== JSON.stringify(g[x]))).map(([k]) => k);
  return { added, removed, changed, renumbered:Boolean(added.length && removed.length) };
}

const HOUR_MS = 3600000;

// NorCal's schedule (times, fields, matchups, added games) is only read at setup, so the cron
// re-reads it hourly from a week before the first day through the last day. Tourney Machine
// refreshes inside runScoreCheck instead; pending schedules have their own hourly rediscovery.
export function norcalScheduleRefreshDue(structure, todayPT, now = Date.now()) {
  const meta = structure?.meta || {};
  if (meta.provider !== 'norcal' || meta.schedulePending || !meta.dates?.length) return false;
  const lastDay = [meta.dates.at(-1), meta.bracketDate].filter(Boolean).sort().at(-1);
  const daysUntil = (Date.parse(meta.dates[0]) - Date.parse(todayPT)) / 86400000;
  if (daysUntil > 7 || todayPT > lastDay) return false;
  return now - Date.parse(meta.scheduleCheckedAt || meta.generatedAt || 0) >= HOUR_MS;
}

// Applies a refreshed NorCal structure. Removed/renumbered games can orphan saved results and
// overrides, so those are left for an admin to review via Re-run setup (which confirms them) —
// the stored structure is kept and only its check time advances. The admin's tournament name is
// always kept.
export function applyNorcalScheduleRefresh(previous, next, checkedAt) {
  const changes = structureChanges(previous, next);
  if (changes.removed.length) {
    return { applied:false, changes, structure:{ ...previous, meta:{ ...previous.meta, scheduleCheckedAt:checkedAt } } };
  }
  return { applied:true, changes,
    structure:{ ...next, meta:{ ...next.meta, name:previous.meta?.name || next.meta?.name, scheduleCheckedAt:checkedAt } } };
}

export function structureIsCurrent(structure, eventRef, team = {}, selection = null) {
  return structure?.meta?.eventId === String(eventRef)
    && structure?.meta?.setupVersion === SETUP_VERSION
    && structure?.meta?.norcalTeamId === (team.norcalTeamId || MY_ID)
    && (structure?.meta?.selectionHash ?? selectionHash(null)) === selectionHash(selection);
}
