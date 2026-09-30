import { createHash } from 'node:crypto';
import { ordinalSuffix, providerRefFromUrl } from './context.js';
import { seasonRecordWithExternal } from './season-record.js';

const FINAL_STATUSES = new Set(['completed', 'won', 'lost']);

function placementNumber(value, label) {
  if (value == null || value === '') return null;
  const place = Number.parseInt(String(value), 10);
  if (!Number.isInteger(place) || place < 1) {
    throw new Error(`${label} must start with a positive place number`);
  }
  return place;
}

function ordinalPlace(place) {
  const n = placementNumber(place, 'placement');
  return `${n}${ordinalSuffix(n)}`;
}

function rowProviderRef(row) {
  return row?.providerRef ? String(row.providerRef) : providerRefFromUrl(row?.url);
}

// Placements used to arrive through two independent paths: editorial season rows and the
// runtime seasonFinishes/event config. Reconcile them before freezing an archive so a captured
// placement cannot disappear just because one representation was stale. Conflicts are fatal:
// silently picking one would make the archive checksum protect incorrect data.
export function reconcileArchivePlacements(seasonData = [], events = {}, seasonFinishes = {}) {
  const rows = structuredClone(seasonData || []);
  const configs = Object.fromEntries(Object.entries(events || {}).map(([key, event]) =>
    [key, structuredClone(event.config || {})]));
  const rowsByKey = new Map(rows.filter(row => row.key).map(row => [String(row.key), row]));
  const rowsByProvider = new Map(rows.map(row => [rowProviderRef(row), row]).filter(([id]) => id));
  const eventsByProvider = new Map(Object.entries(events || {})
    .filter(([, event]) => event.providerRef)
    .map(([key, event]) => [String(event.providerRef), { key, event }]));

  for (const providerRef of Object.keys(seasonFinishes || {})) {
    if (!eventsByProvider.has(String(providerRef))) {
      throw new Error(`captured placement references unknown event: ${providerRef}`);
    }
  }

  for (const [key, event] of Object.entries(events || {})) {
    const row = rowsByKey.get(String(key))
      || (event.providerRef ? rowsByProvider.get(String(event.providerRef)) : null);
    if (!row) throw new Error(
      `season data is missing event row: ${key} (${event.name || key}). `
      + 'Its schedule row was likely deleted from the season editor without removing the '
      + 'event itself — restore a row with this key or providerRef before archiving.',
    );

    const candidates = [
      ['season row', row.finish],
      ['event config', event.config?.knownPlacement?.place],
      ['captured finish', event.providerRef ? seasonFinishes?.[event.providerRef] : null],
    ].map(([source, value]) =>
      [source, placementNumber(value, `${source} placement for ${key}`)])
      .filter(([, place]) => place != null);
    const distinct = [...new Set(candidates.map(([, place]) => place))];
    if (distinct.length > 1) {
      throw new Error(`conflicting placements for ${key}: ${
        candidates.map(([source, place]) => `${source}=${ordinalPlace(place)}`).join(', ')
      }`);
    }
    if (!distinct.length) continue;

    const place = distinct[0];
    row.finish = ordinalPlace(place);
    configs[key] = {
      ...configs[key],
      knownPlacement:{
        ...(configs[key]?.knownPlacement || {}),
        place,
      },
    };
  }
  return { seasonData:rows, eventConfigs:configs };
}

export function freezeSeasonStats(snapshot, eventId, capturedAt = new Date().toISOString(), historicalSnapshots = null) {
  const w = snapshot?.wicked || snapshot?.meta?.wicked || {};
  if (historicalSnapshots) return {
    season:seasonRecordWithExternal(w, [snapshot, ...Object.values(historicalSnapshots)]),
    rank:w.rank ?? null,
    rankOf:w.rankOf ?? null,
    capturedAt,
  };
  const nums = String(w.season || '').split(/[-–]/).map(n => parseInt(n, 10) || 0);
  let wins = nums[0] || 0, losses = nums[1] || 0, ties = nums[2] || 0;
  const historyHasEvent = (w.games || []).some(g => String(g.eventId) === String(eventId));
  if (snapshot?.meta?.provider !== 'norcal' && !historyHasEvent) {
    const seen = new Set();
    const count = (key, myScore, oppScore, status) => {
      if ((key && seen.has(key)) || !FINAL_STATUSES.has(status)) return;
      if (myScore == null || oppScore == null) return;
      if (key) seen.add(key);
      if (Number(myScore) > Number(oppScore)) wins++;
      else if (Number(myScore) < Number(oppScore)) losses++;
      else ties++;
    };
    const myId = snapshot.meta?.providerTeamId;
    Object.values(snapshot.pools || {}).forEach(p => (p.games || []).forEach(g => {
      if (g.hid !== myId && g.aid !== myId) return;
      const r = snapshot.results?.[g.key];
      if (!r) return;
      count(g.key, g.hid === myId ? r.topScore : r.botScore,
        g.hid === myId ? r.botScore : r.topScore, r.status);
    }));
    Object.values(snapshot.bracketGames || {}).forEach(list => (list || []).forEach(g => {
      if (g.topId !== myId && g.botId !== myId) return;
      count(g.key, g.topId === myId ? g.topScore : g.botScore,
        g.topId === myId ? g.botScore : g.topScore, g.status);
    }));
  }
  return {
    season: (w.season || wins || losses || ties) ? `${wins}-${losses}${ties ? `-${ties}` : ''}` : null,
    rank: w.rank ?? null,
    rankOf: w.rankOf ?? null,
    capturedAt,
  };
}

function withoutRuntimeFields(snapshot) {
  if (!snapshot) return null;
  const copy = structuredClone(snapshot);
  delete copy.rev;
  delete copy.config;
  delete copy.seasonData;
  delete copy.seasonFinishes;
  delete copy.context;
  delete copy.catalog;
  delete copy.archivedAt;
  return copy;
}

export function createArchiveBundle({
  team, season, featuredEvent, featuredSnapshot, eventSnapshots = {},
  seasonFinishes = {}, capturedAt = new Date().toISOString(), archiveVersion = 1,
}) {
  const capturedFinishes = { ...seasonFinishes };
  for (const snapshot of [featuredSnapshot, ...Object.values(eventSnapshots || {})]) {
    for (const [providerRef, finish] of Object.entries(snapshot?.seasonFinishes || {})) {
      const prior = capturedFinishes[providerRef];
      if (prior != null
        && placementNumber(prior, `captured placement for ${providerRef}`)
          !== placementNumber(finish, `snapshot placement for ${providerRef}`)) {
        throw new Error(`conflicting captured placements for ${providerRef}`);
      }
      capturedFinishes[providerRef] = finish;
    }
  }
  const placements = reconcileArchivePlacements(
    season.seasonData, season.events, capturedFinishes);
  const frozenSeason = {
    key:season.key,
    name:season.name,
    status:'completed',
    featuredEventKey:season.featuredEventKey,
    seasonData:placements.seasonData,
    finalStats:structuredClone(season.finalStats || null),
    teamConfig:structuredClone(season.teamConfig || {}),
  };
  const events = {};
  for (const [key, event] of Object.entries(season.events || {})) {
    const snapshot = key === featuredEvent.key
      ? featuredSnapshot : eventSnapshots[key] || null;
    events[key] = {
      key,
      name:event.name,
      providerRef:event.providerRef,
      providerTeamId:event.providerTeamId || null,
      sourceUrl:event.sourceUrl || null,
      config:placements.eventConfigs[key],
      snapshotPath:event.snapshotPath || null,
      snapshot:withoutRuntimeFields(snapshot),
    };
  }
  const body = {
    schemaVersion:2,
    archiveVersion,
    capturedAt,
    team:{
      key:team.key, name:team.name, shortName:team.shortName || team.name,
      subtitle:team.subtitle || null,
      norcalTeamId:team.norcalTeamId || null,
      sisterTeamId:team.sisterTeamId || null,
      agePrefix:team.agePrefix || null,
      logoUrl:team.logoUrl || null,
    },
    season:frozenSeason,
    events,
  };
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, checksum:`sha256:${checksum}` };
}

export function verifyArchiveBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== 2) return false;
  try {
    reconcileArchivePlacements(bundle.season?.seasonData, bundle.events);
  } catch {
    return false;
  }
  const { checksum, ...body } = bundle;
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum || '')) return false;
  const actual = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return checksum === `sha256:${actual}`;
}
