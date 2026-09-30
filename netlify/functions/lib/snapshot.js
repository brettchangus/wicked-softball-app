// Snapshot storage + merge helpers (Netlify Blobs). Current records are scoped by the stable
// team/season/event keys. The unscoped structure/results/overrides/config/seasonArchive helpers
// remain only for the one-time migration of deployments created before the v2 catalog.
import { getStore } from '@netlify/blobs';
import { PUBLIC_EVENT_ID } from './tournament.js';
import { buildDefaultModel, canonicalSeasonStatus, normalizeKey } from './context.js';

// Netlify Blobs reads are eventually consistent by default: a read right after a write can return
// the previous value for a while. The admin function opts into strong consistency (see
// useStrongBlobConsistency) so its read-modify-write actions and the page's post-save refresh
// see their own writes. It needs the runtime's uncached edge URL; without one, stay eventual
// rather than throw on every read.
let strongReads = false;
export function useStrongBlobConsistency() { strongReads = true; }
export function strongReadsAvailable() {
  try {
    const raw = globalThis.netlifyBlobsContext || process.env.NETLIFY_BLOBS_CONTEXT;
    return !!(raw && JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).uncachedEdgeURL);
  } catch { return false; }
}
const store = () => strongReads && strongReadsAvailable()
  ? getStore({ name:'tournament', consistency:'strong' })
  : getStore('tournament');
const EMPTY_RESULTS = () => ({ games: {}, standings: {}, bracketGames: {}, poolsDone: {}, bracketsDone: {} });
// Exported (pure string builders, no I/O) so tests/snapshot-scoping.test.mjs can assert the
// scoping invariants directly without mocking @netlify/blobs.
export const scopedKey = (scope, kind) =>
  `v2:${scope.teamKey}:${scope.seasonKey}:${scope.eventKey}:${kind}`;
// Season-level (not per-event) — used for `rev` so switching the active event still
// invalidates tabs pinned to whichever event they last loaded (see readRev/bumpRev).
export const seasonScopedKey = (scope, kind) =>
  `v2:${scope.teamKey}:${scope.seasonKey}:${kind}`;
const teamKey = key => `v2:team:${key}`;
const seasonKey = (team, season) => `v2:season:${team}:${season}`;
const archiveKey = (team, season, version) => `v2:archive:${team}:${season}:v${version}`;

export async function readStructure(eventId, scope = null) {
  if (scope) return store().get(scopedKey(scope, 'structure'), { type: 'json' }).catch(() => null);
  return store().get(`structure:${eventId}`, { type: 'json' }).catch(() => null);
}
export async function writeStructure(eventId, s, scope = null) {
  if (scope) return store().setJSON(scopedKey(scope, 'structure'), s);
  return store().setJSON(`structure:${eventId}`, s);
}
export async function readSetupAttempt(scope) {
  return store().get(scopedKey(scope, 'setupAttempt'), { type:'json' }).catch(() => null);
}
export async function writeSetupAttempt(scope, attempt) {
  return store().setJSON(scopedKey(scope, 'setupAttempt'), attempt);
}
export async function clearSetupAttempt(scope) {
  return store().delete(scopedKey(scope, 'setupAttempt'));
}
export async function readResults(eventId, scope = null) {
  if (scope) return (await store().get(scopedKey(scope, 'results'), { type: 'json' }).catch(() => null)) || EMPTY_RESULTS();
  return (await store().get(`results:${eventId}`, { type: 'json' }).catch(() => null)) || EMPTY_RESULTS();
}
export async function writeResults(eventId, r, scope = null) {
  if (scope) return store().setJSON(scopedKey(scope, 'results'), r);
  return store().setJSON(`results:${eventId}`, r);
}
export async function readOverrides(eventId, scope = null) {
  if (scope) return (await store().get(scopedKey(scope, 'overrides'), { type: 'json' }).catch(() => null)) || {};
  return (await store().get(`overrides:${eventId}`, { type: 'json' }).catch(() => null)) || {};
}
export async function writeOverrides(eventId, o, scope = null) {
  if (scope) return store().setJSON(scopedKey(scope, 'overrides'), o);
  return store().setJSON(`overrides:${eventId}`, o);
}
export async function readGameChangerRecords(scope) {
  return (await store().get(scopedKey(scope, 'gameChangerRecords'), { type:'json' }).catch(() => null)) || {};
}
export async function writeGameChangerRecords(scope, records) {
  return store().setJSON(scopedKey(scope, 'gameChangerRecords'), records);
}

// The active event id is a global override: the admin page writes it (a "switch
// tournaments" without a redeploy); functions read it, falling back to the code constant.
export async function readActiveEventId() {
  return (await store().get('activeEventId').catch(() => null)) || PUBLIC_EVENT_ID;
}
export async function writeActiveEventId(id) {
  return store().set('activeEventId', String(id));
}

// Admin-editable client config (links/editorial + per-game stream links + the season list).
// Served alongside the snapshot and overlaid onto the page's hardcoded defaults.
export async function readConfig() {
  return (await store().get('config', { type: 'json' }).catch(() => null)) || { seasonData: [], events: {} };
}
export async function writeConfig(c) {
  return store().setJSON('config', c);
}

// Frozen read model for the completed season. Kept separate from the live L1/L2/L3 blobs so
// provider corrections, manual pulls, or a future setup cannot alter the public season recap.
export async function readSeasonArchive() {
  return store().get('seasonArchive', { type: 'json' }).catch(() => null);
}
export async function writeSeasonArchive(archive) {
  return store().setJSON('seasonArchive', archive);
}

// ---- Scoped team / season / event model ---------------------------------

export async function readCatalog() {
  return readCatalogStrict().catch(() => null);
}
// null only when the catalog is genuinely absent; a failed read throws so callers that may
// write a catalog never mistake a transient Blob error for an unconfigured site.
function readCatalogStrict() {
  return store().get('v2:catalog', { type: 'json' });
}
export async function writeCatalog(catalog) {
  return store().setJSON('v2:catalog', catalog);
}
export async function readTeam(key) {
  return store().get(teamKey(key), { type: 'json' }).catch(() => null);
}
export async function writeTeam(team) {
  normalizeKey(team?.key, 'team key');
  return store().setJSON(teamKey(team.key), team);
}
export async function readSeason(team, season) {
  const record = await store().get(seasonKey(team, season), { type: 'json' }).catch(() => null);
  if (record?.status) record.status = canonicalSeasonStatus(record.status);
  return record;
}
// Deletion helpers — the storage layer owns the key formats, so admin.js's deleteTeam
// cascade removes records without reconstructing `v2:…` keys itself.
export async function deleteTeamRecord(key) {
  return store().delete(teamKey(key));
}
export async function deleteSeasonRecord(team, season) {
  return store().delete(seasonKey(team, season));
}
export async function deleteSeasonRev(team, season) {
  return store().delete(seasonScopedKey({ teamKey: team, seasonKey: season }, 'rev'));
}
export async function deleteScopedEvent(scope) {
  await Promise.all([
    store().delete(scopedKey(scope, 'structure')),
    store().delete(scopedKey(scope, 'gameChangerRecords')),
    clearScopedEventLiveLayers(scope),
  ]);
}
// When replacing a provider under the same stable event key, keep the old structure
// readable until its replacement has been written.
export async function clearScopedEventLiveLayers(scope) {
  await Promise.all([
    store().delete(scopedKey(scope, 'setupAttempt')),
    store().delete(scopedKey(scope, 'results')),
    store().delete(scopedKey(scope, 'overrides')),
  ]);
}
export async function deleteArchiveRecord(team, season, version) {
  return store().delete(archiveKey(team, season, version));
}
export async function writeSeason(season) {
  normalizeKey(season?.teamKey, 'team key');
  normalizeKey(season?.key, 'season key');
  // Monotonic write stamp: lets the admin page tell a stale (eventually consistent) read of this
  // season from the copy its own save just returned.
  season.updatedAt = new Date(Math.max(Date.now(), Date.parse(season.updatedAt || 0) + 1)).toISOString();
  await store().setJSON(seasonKey(season.teamKey, season.key), season);
  const catalog = await readCatalog();
  if (catalog?.teams?.[season.teamKey]) {
    const summary = catalog.teams[season.teamKey];
    summary.seasons = summary.seasons || {};
    summary.seasons[season.key] = { key:season.key, name:season.name, status:season.status };
    await writeCatalog(catalog);
  }
}

// Thrown when legacy records exist but the catalog's absence can't be confirmed; an admin
// resolves it with the explicit migrateLegacyCatalog action.
export class CatalogMigrationUnconfirmedError extends Error {
  constructor() {
    super('The site catalog could not be confirmed missing, so the legacy migration was not run.');
    this.code = 'catalogMigrationUnconfirmed';
  }
}
// The catalog read with strong consistency, or undefined when the runtime can't provide one.
async function readCatalogStrongly() {
  if (!strongReadsAvailable()) return undefined;
  return getStore({ name:'tournament', consistency:'strong' }).get('v2:catalog', { type:'json' });
}

// One-time compatibility migration. Existing deployed Blobs remain readable throughout:
// the first v2-aware request copies the current event's L1/L2/L3 layers into its scoped keys
// and creates a scoped catalog only when legacy data actually exists.
export async function ensureScopedModel({ migrateLegacy = false } = {}) {
  const existing = await readCatalogStrict();
  if (existing) return existing;
  // An eventually consistent read can return null just after the catalog was written. Confirm
  // before treating the site as empty or rebuilding the catalog from older legacy records.
  const confirmed = await readCatalogStrongly();
  if (confirmed) return confirmed;
  const [config, activeEventId] = await Promise.all([readConfig(), readActiveEventId()]);
  // An empty new site must not auto-publish any team or season. The empty catalog is not
  // persisted: the first admin write (createTeam) publishes the real one.
  if (!config.seasonData?.length && !Object.keys(config.events || {}).length && !activeEventId) {
    return { schemaVersion:2, defaultTeamKey:null, teams:{} };
  }
  // Migration overwrites the team, season, and catalog, so it needs a strongly confirmed
  // absence, or an explicit admin request when this runtime has no strong reads.
  if (confirmed === undefined && !migrateLegacy) throw new CatalogMigrationUnconfirmedError();
  const model = buildDefaultModel(config, activeEventId);
  const event = Object.values(model.season.events).find(e => e.providerRef === activeEventId);
  const scope = event ? {
    teamKey:model.team.key, seasonKey:model.season.key, eventKey:event.key,
  } : null;
  const [structure, results, overrides] = await Promise.all([
    readStructure(activeEventId), readResults(activeEventId), readOverrides(activeEventId),
  ]);
  // Write entity records and copied layers before publishing the catalog pointer.
  await Promise.all([
    writeTeam(model.team),
    store().setJSON(seasonKey(model.team.key, model.season.key), model.season),
    scope && structure ? writeStructure(activeEventId, structure, scope) : null,
    scope ? writeResults(activeEventId, results, scope) : null,
    scope ? writeOverrides(activeEventId, overrides, scope) : null,
  ].filter(Boolean));
  await writeCatalog(model.catalog);
  return model.catalog;
}

export async function resolveContext(input = {}, { allowEmptyEvent = false, allowEmptySeason = false } = {}) {
  const catalog = await ensureScopedModel();
  const requestedTeam = input.teamKey ? normalizeKey(input.teamKey, 'team key') : null;
  const teamKeyValue = requestedTeam || catalog.defaultTeamKey;
  const teamSummary = catalog.teams?.[teamKeyValue];
  if (!teamSummary) throw new Error(`unknown team: ${teamKeyValue}`);
  const team = await readTeam(teamKeyValue);
  if (!team) throw new Error(`team data missing: ${teamKeyValue}`);

  const requestedSeason = input.seasonKey ? normalizeKey(input.seasonKey, 'season key') : null;
  const seasonKeyValue = requestedSeason || teamSummary.defaultSeasonKey || team.defaultSeasonKey;
  const season = await readSeason(teamKeyValue, seasonKeyValue);
  if (!season) {
    // A team can exist with no seasons yet (createTeam no longer forces one). Callers that can
    // cope — the admin's getState, the snapshot's coming-soon path — opt in via allowEmptySeason.
    if (allowEmptySeason) {
      return {
        catalog, team, season:null, event:null,
        teamKey:teamKeyValue, seasonKey:null, eventKey:null, eventId:null, scope:null,
      };
    }
    throw new Error(`unknown season: ${seasonKeyValue}`);
  }

  const requestedEvent = input.eventKey ? normalizeKey(input.eventKey, 'event key') : null;
  const eventKeyValue = requestedEvent || season.featuredEventKey;
  const event = season.events?.[eventKeyValue];
  if (!event && allowEmptyEvent && !requestedEvent) {
    return {
      catalog, team, season, event:null,
      teamKey:teamKeyValue, seasonKey:seasonKeyValue, eventKey:null,
      eventId:null, scope:null,
    };
  }
  if (!event) throw new Error(`unknown event: ${eventKeyValue}`);
  if (!event.providerRef) throw new Error(`event has no provider reference: ${eventKeyValue}`);
  return {
    catalog, team, season, event,
    teamKey:teamKeyValue, seasonKey:seasonKeyValue, eventKey:eventKeyValue,
    eventId:event.providerRef,
    scope:{ teamKey:teamKeyValue, seasonKey:seasonKeyValue, eventKey:eventKeyValue },
  };
}

export async function listSeasonContexts({ status = null } = {}) {
  const catalog = await ensureScopedModel();
  // Teams (and each team's seasons) are read in parallel — this runs on every check-scores
  // cron tick, so it shouldn't scale as sequential Blob round-trips with catalog size.
  const teamEntries = await Promise.all(
    Object.entries(catalog.teams || {}).map(async ([teamKeyValue, teamSummary]) =>
      [teamKeyValue, teamSummary, await readTeam(teamKeyValue)]),
  );
  const contexts = [];
  for (const [teamKeyValue, teamSummary, team] of teamEntries) {
    if (!team) continue;
    const seasonKeys = Object.keys(teamSummary.seasons || {});
    const seasons = await Promise.all(seasonKeys.map(seasonKeyValue => readSeason(teamKeyValue, seasonKeyValue)));
    seasonKeys.forEach((seasonKeyValue, i) => {
      const season = seasons[i];
      if (!season || (status && season.status !== status) || !season.featuredEventKey) return;
      const event = season.events?.[season.featuredEventKey];
      if (!event?.providerRef) return;
      contexts.push({
        catalog, team, season, event,
        teamKey:teamKeyValue, seasonKey:seasonKeyValue, eventKey:event.key,
        eventId:event.providerRef,
        scope:{ teamKey:teamKeyValue, seasonKey:seasonKeyValue, eventKey:event.key },
      });
    });
  }
  return contexts;
}

export function contextInputFromRequest(req) {
  const url = new URL(req.url);
  return {
    teamKey:url.searchParams.get('team') || undefined,
    seasonKey:url.searchParams.get('season') || undefined,
    eventKey:url.searchParams.get('eventKey') || undefined,
  };
}

export async function readScopedArchive(team, season, version = null) {
  const seasonRecord = await readSeason(team, season);
  const v = version || seasonRecord?.archiveVersion;
  if (!v) return null;
  return store().get(archiveKey(team, season, v), { type:'json' }).catch(() => null);
}
export async function writeScopedArchive(bundle, { replace = false } = {}) {
  const team = normalizeKey(bundle?.team?.key || bundle?.teamKey, 'team key');
  const season = normalizeKey(bundle?.season?.key || bundle?.seasonKey, 'season key');
  const version = Number(bundle?.archiveVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error('archiveVersion must be a positive integer');
  const key = archiveKey(team, season, version);
  if (!replace && await store().get(key).catch(() => null)) throw new Error(`archive v${version} already exists`);
  await store().setJSON(key, bundle);
}

// `rev` is a season-level (not per-event) refresh token, scoped by team+season only. This
// alone does NOT stop a client from re-requesting a stale eventKey after reload — resolveContext
// has no fallback logic and always honors an explicit eventKey (see below); the client is what
// must avoid sending one it wasn't explicitly asked to load (index.html's contextQuery() only
// echoes routeContext.eventKey — captured once from the URL — never the mutable APP_CONTEXT
// value the server resolves it to). What season-scoping `rev` buys is: a tab that legitimately
// has no explicit eventKey still needs telling to reload/re-resolve when the season's featured
// event changes, and per-event scoping wouldn't reach it (its last request's eventKey differs
// from the new one). Bumping it makes open clients reload on their next poll — a silent,
// no-notification "force refresh".
export async function readRev(scope = null) {
  if (scope) return (await store().get(seasonScopedKey(scope, 'rev')).catch(() => null))
    || (await store().get('rev').catch(() => null)) || null;
  return (await store().get('rev').catch(() => null)) || null;
}
export async function bumpRev(scope = null) {
  const rev = String(Date.now());
  if (scope) {
    await store().set(seasonScopedKey(scope, 'rev'), rev);
    return rev;
  }
  await store().set('rev', rev);
  return rev;
}

// Merge L1 + L2 + L3 into the snapshot the client consumes. Overrides win (and are
// flagged `manual`). Per-pool standings are attached onto each pool.
export function mergeSnapshot(structure, results, overrides) {
  if (!structure) return null;
  const r = results || EMPTY_RESULTS();
  const games = { ...(r.games || {}) };
  for (const [k, o] of Object.entries(overrides || {})) games[k] = { ...(games[k] || {}), ...o, manual: true };
  const pools = {};
  for (const [k, p] of Object.entries(structure.pools || {})) pools[k] = { ...p, standings: (r.standings || {})[k] || [] };
  return {
    meta: structure.meta,
    poolOrder: structure.poolOrder,
    pools,
    brackets: structure.brackets,
    results: games,
    bracketGames: r.bracketGames || {},
    updatedAt: r.updatedAt || null,
    wicked: r.wicked || (structure.meta && structure.meta.wicked) || null,  // season record + NorCal rank
  };
}
