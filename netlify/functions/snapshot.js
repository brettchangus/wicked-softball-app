// GET /api/snapshot — serves the merged tournament snapshot (structure + live results +
// manual overrides) for the current event. The page reads this on load + on its refresh
// interval. Returns 503 before the first setup run; no real-data fixture is shipped.
import {
  readStructure, readResults, readOverrides, readRev, readSeasonArchive, readScopedArchive,
  resolveContext, contextInputFromRequest, mergeSnapshot, readCatalog, readGameChangerRecords,
} from './lib/snapshot.js';
import { ordinalSuffix, publicCatalog, seasonIsComplete } from './lib/context.js';
import { verifyArchiveBundle } from './lib/archive.js';
import { effectiveRoster } from './lib/minigame.js';
import { seasonRecordWithExternal } from './lib/season-record.js';
import { mergeRecentResults } from './lib/recent-results.js';
import { gameChangerLinksForContext, resolvedGameChangerLinks } from './lib/gamechanger.js';
import { recordsForGameChangerLinks, locationsForGameChangerLinks } from './lib/gamechanger-records.js';

// A team can exist without a resolvable season/event yet (a newly-created team, or a season with
// no featured event). Rather than a hard 404, return a friendly "coming soon" payload the client
// renders as a placeholder screen, still carrying the catalog so the team/season picker works.
async function comingSoon(reason, context) {
  const catalog = context?.catalog || await readCatalog().catch(() => null);
  return json({
    comingSoon: true,
    reason,
    context: context ? {
      team: { key:context.team.key, name:context.team.name, shortName:context.team.shortName || context.team.name, subtitle:context.team.subtitle || null, logoUrl:context.team.logoUrl || null },
      season: context.season ? { key:context.season.key, name:context.season.name, status:context.season.status } : null,
    } : null,
    catalog: catalog ? publicCatalog(catalog) : null,
    // The Homerun Derby still shows on the coming-soon screen when this season has a roster.
    miniGame: { roster: context?.season ? effectiveRoster({ teamKey:context.teamKey, seasonKey:context.seasonKey, season:context.season }) : [] },
  });
}

export default async function handler(req) {
  let context;
  try {
    context = await resolveContext(contextInputFromRequest(req), { allowEmptyEvent:true, allowEmptySeason:true });
  } catch (error) {
    return json({ error:error.message }, 404);  // unknown team etc.
  }
  // Team exists but nothing to render yet → friendly "coming soon", not an error.
  if (!context.season) return comingSoon('no-season', context);
  if (!context.event) return comingSoon('no-event', context);
  const { catalog, team, season, event, eventId, scope } = context;
  const rev = await readRev(scope);
  let snap, archivedAt = null, archiveBundle = null;
  if (seasonIsComplete(season)) {
    archiveBundle = await readScopedArchive(context.teamKey, context.seasonKey);
    if (archiveBundle && !verifyArchiveBundle(archiveBundle)) archiveBundle = null;
    if (!archiveBundle && season.archiveExport?.path) {
      try {
        const response = await fetch(new URL('/' + season.archiveExport.path.replace(/^\/+/, ''), req.url));
        if (response.ok) {
          const candidate = await response.json();
          if (verifyArchiveBundle(candidate)) archiveBundle = candidate;
        }
      } catch {}
    }
    const archivedEvent = archiveBundle?.events?.[context.eventKey];
    if (archivedEvent?.snapshot) {
      snap = structuredClone(archivedEvent.snapshot);
      archivedAt = archiveBundle.capturedAt || null;
    } else {
      // Compatibility for the original single global seasonArchive, migrated lazily.
      const legacy = await readSeasonArchive();
      if (legacy?.snapshot && (!legacy.eventId || legacy.eventId === eventId)) {
        snap = structuredClone(legacy.snapshot);
        archivedAt = legacy.capturedAt || null;
      }
    }
  }
  if (!snap) {
    const [structure, results, overrides] = await Promise.all([
      readStructure(eventId, scope), readResults(eventId, scope), readOverrides(eventId, scope),
    ]);
    snap = mergeSnapshot(structure, results, overrides);
  }
  if (!snap) return json({ error:'no snapshot yet' }, 503);
  const archivedEvent = archiveBundle?.events?.[context.eventKey];
  const servedTeam = archiveBundle?.team || team;
  const servedSeason = archiveBundle?.season || season;
  const servedEvents = archiveBundle?.events || season.events || {};
  const servedFinalStats = servedSeason.finalStats || season.finalStats;
  // The team profile's season record only covers NorCal games. Read each tournament's
  // snapshot so AST and Tourney Machine results contribute to the same header record.
  const eventSnapshots = await Promise.all(Object.entries(servedEvents).map(async ([key, item]) => {
    if (key === context.eventKey) return snap;
    if (archiveBundle) return item.snapshot || null;
    const eventScope = { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:key };
    const [structure, results, overrides] = await Promise.all([
      readStructure(item.providerRef, eventScope), readResults(item.providerRef, eventScope),
      readOverrides(item.providerRef, eventScope),
    ]);
    if (structure) {
      return mergeSnapshot(structure, results, overrides);
    }
    if (!item.snapshotPath) return null;
    try {
      const response = await fetch(new URL('/' + item.snapshotPath.replace(/^\/+/, ''), req.url),
        { signal:AbortSignal.timeout(5000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }));
  const recordComplete = Object.entries(servedEvents).every(([key, item], i) =>
    eventSnapshots[i] || item.status === 'upcoming');
  const computedRecord = recordComplete
    ? seasonRecordWithExternal(snap.wicked || snap.meta?.wicked, eventSnapshots.filter(Boolean)) : null;
  snap.rev = rev;
  snap.config = {
    ...(servedSeason.teamConfig || {}),
    ...(archivedEvent?.config || event.config || {}),
    teamKey:context.teamKey,
    teamName:servedTeam.name,
    teamShortName:servedTeam.shortName || servedTeam.name,
    seasonKey:context.seasonKey,
    seasonName:servedSeason.name,
    eventKey:context.eventKey,
    seasonOver:seasonIsComplete(season),
    // Public by definition; the private VAPID key remains in the site's environment.
    vapidPublicKey:process.env.VAPID_PUBLIC_KEY || '',
  };
  // Like opponent profiles, this editorial link can be corrected after a season is archived.
  if ('gameChangerUrl' in (season.teamConfig || {}))
    snap.config.gameChangerUrl = season.teamConfig.gameChangerUrl;
  // Profile links are editorial and may be corrected after archival; keep the frozen game
  // snapshot while applying the current event's link corrections over archived config.
  snap.config.gameChangerTeams = resolvedGameChangerLinks(snap, gameChangerLinksForContext(context, {
    ...(archivedEvent?.config?.gameChangerTeams || {}),
    ...(event.config?.gameChangerTeams || {}),
  }));
  snap.config.gameChangerTeamNames = resolvedGameChangerLinks(snap, {
    ...(archivedEvent?.config?.gameChangerTeamNames || {}),
    ...(event.config?.gameChangerTeamNames || {}),
  });
  const recordLinks = {
    ...snap.config.gameChangerTeams,
    ...(snap.config.gameChangerUrl && snap.meta?.providerTeamId
      ? { [snap.meta.providerTeamId]:snap.config.gameChangerUrl } : {}),
  };
  const savedGameChangerProfiles = await readGameChangerRecords(scope);
  snap.config.gameChangerRecords = recordsForGameChangerLinks(recordLinks, savedGameChangerProfiles);
  snap.config.gameChangerLocations = locationsForGameChangerLinks(recordLinks, savedGameChangerProfiles);
  if (seasonIsComplete(season) && servedFinalStats) {
    const f = servedFinalStats;
    snap.wicked = {
      ...(snap.wicked || snap.meta?.wicked || {}),
      season: f.season ?? null,
      rank: f.rank ?? null,
      rankOf: f.rankOf ?? null,
      seasonFrozen: true,
    };
    snap.archivedAt = archivedAt || f.capturedAt || null;
  }
  if (computedRecord != null) {
    snap.wicked = { ...(snap.wicked || snap.meta?.wicked || {}), season:computedRecord, seasonFrozen:true };
  }
  snap.wicked = mergeRecentResults(snap.wicked || snap.meta?.wicked, eventSnapshots.filter(Boolean));
  snap.seasonData = servedSeason.seasonData?.length ? servedSeason.seasonData : null;
  snap.seasonFinishes = Object.fromEntries(
    Object.values(servedEvents)
      .map(e => [e.providerRef, e.config?.knownPlacement?.place])
      .filter(([, place]) => place)
      .map(([id, place]) => [id, ordinalPlace(place)]),
  );
  snap.archiveEvents = Object.fromEntries(Object.values(servedEvents)
    .filter(e => e.providerRef)
    .map(e => [e.providerRef, {
      eventKey:e.key, name:e.name, snapshotPath:e.snapshotPath || null,
      archived:seasonIsComplete(season),
    }]));
  snap.context = {
    team:{
      key:servedTeam.key, name:servedTeam.name, shortName:servedTeam.shortName || servedTeam.name,
      subtitle:servedTeam.subtitle || null, logoUrl:servedTeam.logoUrl || null,
      norcalTeamId:servedTeam.norcalTeamId || null,
      sisterTeamId:servedTeam.sisterTeamId || null,
    },
    season:{ key:servedSeason.key, name:servedSeason.name, status:season.status, archiveVersion:season.archiveVersion || null },
    event:{ key:event.key, name:event.name, providerRef:event.providerRef },
  };
  snap.catalog = publicCatalog(catalog);
  // Homerun Derby roster for this team + season — from the LIVE season record (not an archive
  // bundle): it's game config an admin can keep editing after a season completes.
  snap.miniGame = { roster: effectiveRoster({ teamKey:context.teamKey, seasonKey:context.seasonKey, season }) };
  // No HTTP caching: during the active season, score overrides must appear immediately; after
  // archival, config/rev changes (including reopening the season) must still reach clients.
  return json(snap);
}

function ordinalPlace(value) {
  const existing = String(value).match(/^\d+(?:st|nd|rd|th)/i)?.[0];
  if (existing) return existing;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return String(value);
  return `${n}${ordinalSuffix(n)}`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers:{
      'Content-Type':'application/json',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':'no-store',
    },
  });
}

export const config = { path: '/api/snapshot' };
