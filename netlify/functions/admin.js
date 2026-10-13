// Admin write endpoint for admin.html. POST /admin  { action, ... }
// Locked behind ADMIN_SECRET (falls back to SETUP_SECRET); fail closed if unset.
// All score/config writes bump `rev` so open tabs reload within ~60s. Broadcast push is
// done by the page POSTing straight to /notify (which already owns the subscriber loop).
import { getStore } from '@netlify/blobs';
import { buildProviderStructure, parseEventRef, detectNorcalEvent, detectTourneyMachineEvent, detectAstEvent, structureChanges } from './lib/providers.js';
import { changedTourneyMachineIdentities } from './lib/tourneymachine.js';
import { runScoreCheck, isManualPlacement } from './lib/scores.js';
import {
  readStructure, writeStructure, readResults, writeResults, readOverrides, writeOverrides,
  readCatalog, writeCatalog, readTeam, writeTeam, readSeason, writeSeason,
  ensureScopedModel, resolveContext, readScopedArchive, writeScopedArchive, bumpRev, mergeSnapshot,
  deleteTeamRecord, deleteSeasonRecord, deleteSeasonRev, deleteScopedEvent, clearScopedEventLiveLayers, deleteArchiveRecord,
  useStrongBlobConsistency, readGameChangerRecords,
} from './lib/snapshot.js';
import {
  canonicalSeasonData, effectiveSelection, eventsFromSeasonData, keyFromName, normalizeKey, publicCatalog,
  formatCalendarDates, seasonIsComplete, validCalendarDate,
} from './lib/context.js';
import {
  createArchiveBundle, freezeSeasonStats,
} from './lib/archive.js';
import { DEFAULT_TEAM_KEY } from './lib/tournament.js';
import { parseAge } from './lib/divisions.js';
import { AST_DEFAULT_SEEDING_RULES, normalizeSeedingRules } from './lib/seeding.js';
import {
  boardCacheKey, boardKey, effectiveRoster, isDefaultMiniGameContext, LEGACY_BOARD_KEY, normalizeRoster,
  scorePrefix,
} from './lib/minigame.js';
import { gameChangerLinksForContext, gameChangerOpponents, resolvedGameChangerLinks } from './lib/gamechanger.js';
import { searchGameChangerTeams } from './lib/gamechanger-search.js';
import { refreshGameChangerRecords, locationsForGameChangerLinks } from './lib/gamechanger-records.js';
import {
  normalizeOpponentFields, opponentOverrides, opponentRows, opponentSearchInput, providerTeamLocations,
} from './lib/opponents.js';

function linkedGameChangerRecordUrls(context, structure) {
  const links = resolvedGameChangerLinks(structure, gameChangerLinksForContext(context,
    context.event?.config?.gameChangerTeams));
  const ownId = structure?.meta?.providerTeamId;
  const ownUrl = context.season?.teamConfig?.gameChangerUrl;
  if (ownId && ownUrl) links[ownId] = ownUrl;
  return links;
}

// A https://web.gc.com/teams/… profile URL, normalized; null when it is anything else.
function gameChangerProfileUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '').trim()); } catch { return null; }
  return parsed.protocol === 'https:' && parsed.hostname === 'web.gc.com' && /^\/teams\/[^/]+/.test(parsed.pathname)
    ? parsed.href : null;
}

// Opponent edits change one tournament's config inside the whole season record. Re-read the
// season right before writing and touch only that config, so a save made elsewhere while this
// request was working (a GameChanger search can take seconds) is not overwritten.
async function updateEventConfig(context, mutate) {
  const season = await readSeason(context.teamKey, context.seasonKey) || context.season;
  const event = season.events?.[context.eventKey];
  if (!event) throw new Error(`unknown event: ${context.eventKey}`);
  event.config = event.config || {};
  mutate(event.config);
  await writeSeason(season);
  context.season = season;
  context.event = event;
  return event.config;
}

function setGameChangerLink(config, teamId, url, name) {
  const priorUrl = config.gameChangerTeams?.[teamId];
  const gcName = String(name || '').trim().slice(0, 120)
    || (priorUrl === url ? config.gameChangerTeamNames?.[teamId] : '') || '';
  config.gameChangerTeams = { ...(config.gameChangerTeams || {}), [teamId]:url };
  config.gameChangerTeamNames = { ...(config.gameChangerTeamNames || {}), [teamId]:gcName || null };
  return gcName || null;
}

function clearGameChangerLink(config, teamId) {
  config.gameChangerTeams = { ...(config.gameChangerTeams || {}), [teamId]:null };
  config.gameChangerTeamNames = { ...(config.gameChangerTeamNames || {}), [teamId]:null };
}

export default async function handler(req) {
  useStrongBlobConsistency();
  const url = new URL(req.url);
  const secret = process.env.ADMIN_SECRET || process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) return json({ error: 'forbidden' }, 403);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body = {};
  try { body = await req.json(); } catch {}
  const action = body.action;

  try {
    if (action === 'getCatalog') {
      const catalog = await ensureScopedModel();
      return json({ ok:true, catalog:publicCatalog(catalog) });
    }
    // Explicit, confirmed migration for runtimes that can't strongly confirm the catalog is absent.
    if (action === 'migrateLegacyCatalog') {
      const catalog = await ensureScopedModel({ migrateLegacy:true });
      return json({ ok:true, catalog:publicCatalog(catalog) });
    }
    if (action === 'createTeam') return await createTeam(body);
    if (action === 'createSeason') return await createSeason(body);
    if (action === 'updateTeam') return await updateTeam(body);
    if (action === 'deleteTeam') return await deleteTeam(body);
    if (action === 'updateSeason') return await updateSeason(body);
    if (action === 'deleteSeason') return await deleteSeason(body);
    if (action === 'setActiveContext') return await setActiveContext(body);

    const context = await resolveContext(body, {
      allowEmptyEvent:['getState', 'setSeasonData', 'switchEvent', 'detectEvent', 'saveEvent',
        'setMiniGameRoster', 'getMiniGameRoster', 'resetHighScores'].includes(action),
      // getState must work for a team that has no season yet (createTeam no longer forces one),
      // so the admin can still show + edit the team.
      allowEmptySeason:['getState'].includes(action),
    });
    const { team, season, event, eventId, scope } = context;
    switch (action) {
      // Read-only convenience: everything the admin forms need to populate themselves.
      case 'getState': {
        const subsStore = getStore('push-subscriptions');
        const { blobs } = await subsStore.list();
        // A season-less team still needs its record returned so the team editor can populate.
        if (!season) {
          return json({
            ok:true, noSeason:true,
            context:{ teamKey:context.teamKey, seasonKey:null, eventKey:null },
            catalog:publicCatalog(context.catalog),
            team, season:null, activeEventId:null, activeEventKey:null, overrides:{},
            config:{ seasonData:[], seasonOver:false, seasonFinalStats:null, events:{} },
            subscriberCount: blobs.length, meta:null,
          });
        }
        const [structure, overrides, gameChangerProfiles] = event ? await Promise.all([
          readStructure(eventId, scope), readOverrides(eventId, scope), readGameChangerRecords(scope),
        ]) : [null, {}, {}];
        const gameChangerLinks = resolvedGameChangerLinks(structure,
          gameChangerLinksForContext(context, event?.config?.gameChangerTeams));
        // Each tournament's provider-discovered venue (from its last setup), so the tournament
        // editor can show what the weather card uses when no lat/lon override is set.
        const eventVenues = Object.fromEntries(await Promise.all(Object.values(season.events || {})
          .filter(item => item.providerRef)
          .map(async item => [item.key, (await readStructure(item.providerRef,
            { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:item.key }))?.meta?.venue || null])));
        return json({
          ok:true,
          context:{ teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:context.eventKey },
          catalog:publicCatalog(context.catalog),
          team, season,
          activeEventId:eventId, activeEventKey:event?.key || null, overrides,
          gameChangerOpponents:gameChangerOpponents(structure),
          // The Opponents card: each opponent's resolved display values, the defaults they fall
          // back to, and what the admin has overridden.
          opponents:opponentRows(structure, event?.config?.opponents,
            locationsForGameChangerLinks(gameChangerLinks, gameChangerProfiles)),
          seedingDefaults:{ ast:AST_DEFAULT_SEEDING_RULES },
          // Compatibility shape used by the existing admin form while its controls migrate.
          config:{
            ...(season.teamConfig || {}),
            seasonData:season.seasonData || [],
            seasonOver:seasonIsComplete(season),
            seasonFinalStats:season.finalStats || null,
            events:event ? { [eventId]:{
              ...(event.config || {}),
              gameChangerTeams:gameChangerLinks,
              gameChangerTeamNames:resolvedGameChangerLinks(structure,
                event.config?.gameChangerTeamNames),
            } } : {},
          },
          subscriberCount: blobs.length, eventVenues,
          miniGameRoster: effectiveRoster({ teamKey:context.teamKey, seasonKey:context.seasonKey, season }),
          meta: structure?.meta ? { name: structure.meta.name, dates: structure.meta.dates, bracketDate: structure.meta.bracketDate } : null,
        });
      }

      // ---- Manual score overrides (L3) ----
      case 'setOverride': {
        if (!body.key) return json({ error: 'key required' }, 400);
        const overrides = await readOverrides(eventId, scope);
        const o = {};
        if (body.topScore != null && body.topScore !== '') o.topScore = Number(body.topScore);
        if (body.botScore != null && body.botScore !== '') o.botScore = Number(body.botScore);
        if (body.status) o.status = body.status;            // 'completed' | 'won' | 'lost'
        if (body.note != null) o.note = body.note;
        overrides[body.key] = o;
        await writeOverrides(eventId, overrides, scope);
        return await done(scope, { key: body.key, override: o });
      }
      case 'clearOverride': {
        if (!body.key) return json({ error: 'key required' }, 400);
        const overrides = await readOverrides(eventId, scope);
        delete overrides[body.key];
        await writeOverrides(eventId, overrides, scope);
        return await done(scope, { key: body.key, cleared: true });
      }

      // ---- Client config (links / editorial / placement / venue) ----
      case 'setEventConfig': {
        const incoming = body.config || {};
        season.teamConfig = season.teamConfig || {};
        const priorGameChangerUrl = season.teamConfig.gameChangerUrl || '';
        if ('snacksUrl' in incoming) season.teamConfig.snacksUrl = incoming.snacksUrl;
        if ('gameChangerUrl' in incoming) {
          const rawUrl = String(incoming.gameChangerUrl || '').trim();
          let parsed;
          if (rawUrl) {
            try { parsed = new URL(rawUrl); } catch { return json({ error:'invalid GameChanger URL' }, 400); }
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'web.gc.com' || !/^\/teams\/[^/]+/.test(parsed.pathname))
              return json({ error:'use a https://web.gc.com/teams/... profile URL' }, 400);
          }
          season.teamConfig.gameChangerUrl = parsed?.href || '';
        }
        const ev = {};
        for (const k of ['rulesUrl', 'customLink', 'accuweatherUrl', 'knownPlacement', 'venue']) if (k in incoming) ev[k] = incoming[k];
        event.config = { ...(event.config || {}), ...ev };
        await writeSeason(season);
        if (season.teamConfig.gameChangerUrl && season.teamConfig.gameChangerUrl !== priorGameChangerUrl) {
          const structure = await readStructure(eventId, scope);
          const ownId = structure?.meta?.providerTeamId;
          if (ownId) await refreshGameChangerRecords(scope, linkedGameChangerRecordUrls(context, structure),
            { teamIds:[ownId], updateLocation:true }).catch(() => {});
        }
        return await done(scope, { eventId, event:event.config, ...season.teamConfig });
      }

      // GameChanger identities are editorial links: provider team ids identify the opponent
      // within this tournament, and the admin confirms the matching GC season profile.
      case 'searchGameChangerTeam':
      case 'autoFindGameChangerTeams': {
        const structure = await readStructure(eventId, scope);
        if (!structure) return json({ error:'Tournament schedule is unavailable' }, 400);
        const opponents = new Map(gameChangerOpponents(structure).map(t => [t.teamId, t.name]));
        if (action === 'searchGameChangerTeam' && !opponents.has(String(body.teamId || '')))
          return json({ error:'team is not in this tournament' }, 400);
        const date = (season.seasonData || []).find(row => row.key === event.key)?.startDate
          || String(structure.meta?.dates?.[0] || '');
        const age = team.agePrefix || '';
        const targets = action === 'searchGameChangerTeam'
          ? [[String(body.teamId), opponents.get(String(body.teamId))]]
          : [...opponents].filter(([id]) => !resolvedGameChangerLinks(structure,
            gameChangerLinksForContext(context, event.config?.gameChangerTeams))[id]);
        // Match against the admin's edits first (a single-team search may send the editor's
        // unsaved draft), then the provider's own name and location.
        const savedOverrides = opponentOverrides(structure, event.config?.opponents);
        const providerLocations = providerTeamLocations(structure);
        let draft = {};
        if (action === 'searchGameChangerTeam' && body.draft && typeof body.draft === 'object') {
          const checked = normalizeOpponentFields(body.draft);
          if (checked.error) return json({ error:checked.error }, 400);
          draft = checked.fields;
        }
        const results = await Promise.all(targets.map(async ([teamId, name]) => {
          try {
            const input = opponentSearchInput(name, {
              override:{ ...(savedOverrides[teamId] || {}), ...draft }, provider:providerLocations[teamId] });
            const candidates = await searchGameChangerTeams(input.name, { age, date, token:body.gcToken,
              team:input.team, coach:input.coach, city:input.city, state:input.state || undefined });
            return { teamId, name, candidates };
          } catch (error) {
            return { teamId, name, candidates:[], error:error.message };
          }
        }));
        const authError = results.find(row => /Enter a GameChanger token|token expired/.test(row.error || ''));
        if (authError) return json({ error:authError.error, code:'gameChangerToken' }, 503);
        if (action === 'autoFindGameChangerTeams' && results.length && results.every(row => row.error))
          return json({ error:results[0].error }, 502);
        if (action === 'searchGameChangerTeam') return json({ ok:true, ...results[0] });
        const confident = results.flatMap(row => {
          const sure = row.candidates.filter(candidate => candidate.autoMatch);
          return sure.length === 1 ? [{ teamId:row.teamId, name:row.name, url:sure[0].url, gcName:sure[0].name }] : [];
        });
        const matched = [];
        if (confident.length) {
          await updateEventConfig(context, config => {
            for (const row of confident) {
              // A link saved while the searches ran wins over the automatic match.
              if (config.gameChangerTeams?.[row.teamId]) continue;
              setGameChangerLink(config, row.teamId, row.url, row.gcName);
              matched.push({ teamId:row.teamId, name:row.name, url:row.url });
            }
          });
          await refreshGameChangerRecords(scope, linkedGameChangerRecordUrls(context, structure),
            { teamIds:matched.map(row => row.teamId), updateLocation:true }).catch(() => {});
        }
        return await done(scope, { matched, unresolved:results.filter(row => !confident.some(item => item.teamId === row.teamId)),
          failed:results.filter(row => row.error) });
      }
      // One save for an opponent's editable properties. `fields` carries only what changed:
      // name / coach / city / state ('' = fall back to the provider's value) and gcUrl / gcName
      // ('' gcUrl = remove the link).
      case 'saveOpponent': {
        const teamId = String(body.teamId || '').trim();
        const input = body.fields && typeof body.fields === 'object' ? body.fields : {};
        if (!teamId) return json({ error:'team required' }, 400);
        const structure = await readStructure(eventId, scope);
        if (!gameChangerOpponents(structure).some(t => t.teamId === teamId))
          return json({ error:'team is not in this tournament' }, 400);
        const checked = normalizeOpponentFields(input);
        if (checked.error) return json({ error:checked.error }, 400);
        let link;                                   // undefined = unchanged, null = remove
        if ('gcUrl' in input) {
          const rawUrl = String(input.gcUrl || '').trim();
          link = rawUrl ? gameChangerProfileUrl(rawUrl) : null;
          if (rawUrl && !link) return json({ error:'use a https://web.gc.com/teams/... profile URL' }, 400);
        }
        if (!Object.keys(checked.fields).length && link === undefined && !('gcName' in input))
          return json({ error:'nothing to save' }, 400);
        const saved = await updateEventConfig(context, config => {
          if (Object.keys(checked.fields).length) {
            // Start from the override as resolved (one saved against a pending schedule's
            // name-based key follows the team to its published id) and keep the entry even when
            // empty, so a cleared field is not re-filled from that older key.
            const current = { ...(opponentOverrides(structure, config.opponents)[teamId] || {}) };
            for (const [key, value] of Object.entries(checked.fields)) {
              if (value) current[key] = value; else delete current[key];
            }
            config.opponents = { ...(config.opponents || {}), [teamId]:current };
          }
          if (link) setGameChangerLink(config, teamId, link, input.gcName);
          else if (link === null) clearGameChangerLink(config, teamId);
          else if ('gcName' in input && config.gameChangerTeams?.[teamId])
            setGameChangerLink(config, teamId, config.gameChangerTeams[teamId], input.gcName);
        });
        if (link) await refreshGameChangerRecords(scope, linkedGameChangerRecordUrls(context, structure),
          { teamIds:[teamId], updateLocation:true }).catch(() => {});
        return await done(scope, { teamId, opponent:saved.opponents?.[teamId] || {},
          url:saved.gameChangerTeams?.[teamId] || null, name:saved.gameChangerTeamNames?.[teamId] || null });
      }
      // Compatibility aliases — the Opponents editor saves through saveOpponent.
      case 'setGameChangerTeamLink': {
        const teamId = String(body.teamId || '').trim();
        const rawUrl = String(body.url || '').trim();
        if (!teamId || !rawUrl) return json({ error:'team and GameChanger URL required' }, 400);
        const structure = await readStructure(eventId, scope);
        const known = gameChangerOpponents(structure).some(t => t.teamId === teamId);
        if (!known) return json({ error:'team is not in this tournament' }, 400);
        try { new URL(rawUrl); } catch { return json({ error:'invalid GameChanger URL' }, 400); }
        const link = gameChangerProfileUrl(rawUrl);
        if (!link) return json({ error:'use a https://web.gc.com/teams/... profile URL' }, 400);
        let gcName = null;
        await updateEventConfig(context, config => { gcName = setGameChangerLink(config, teamId, link, body.name); });
        await refreshGameChangerRecords(scope, linkedGameChangerRecordUrls(context, structure),
          { teamIds:[teamId], updateLocation:true }).catch(() => {});
        return await done(scope, { teamId, url:link, name:gcName });
      }
      case 'refreshGameChangerRecords': {
        const structure = await readStructure(eventId, scope);
        const result = await refreshGameChangerRecords(scope, linkedGameChangerRecordUrls(context, structure));
        return await done(scope, { records:result.records, checked:result.checked, changed:result.changed, updated:result.updated, failed:result.failed });
      }
      case 'clearGameChangerTeamLink': {
        const teamId = String(body.teamId || '').trim();
        if (!teamId) return json({ error:'team required' }, 400);
        await updateEventConfig(context, config => clearGameChangerLink(config, teamId));
        return await done(scope, { teamId, cleared:true });
      }

      // ---- Per-game stream links ----
      case 'setStreamLink': {
        if (!body.key || !body.url) return json({ error: 'key and url required' }, 400);
        event.config = event.config || {};
        event.config.streamLinks = { ...(event.config.streamLinks || {}), [body.key]:body.url };
        await writeSeason(season);
        return await done(scope, { key:body.key, url:body.url });
      }
      case 'clearStreamLink': {
        if (!body.key) return json({ error: 'key required' }, 400);
        if (event.config?.streamLinks) {
          delete event.config.streamLinks[body.key];
          await writeSeason(season);
        }
        return await done(scope, { key:body.key, cleared:true });
      }

      // ---- Season schedule (replaces the whole array) ----
      case 'setSeasonData': {
        if (!Array.isArray(body.seasonData)) return json({ error: 'seasonData array required' }, 400);
        if (body.seasonData.filter(row => row?.status === 'now').length > 1)
          return json({ error:'only one tournament can be Active' }, 400);
        const configs = Object.fromEntries(Object.values(season.events || {})
          .filter(e => e.providerRef).map(e => [e.providerRef, e.config || {}]));
        const rebuilt = eventsFromSeasonData(body.seasonData, configs, eventId);
        // Preserve provider-specific fields that are not represented by the season editor.
        // eventsFromSeasonData rebuilds providerTeamId from scratch (null for anything but the
        // default team's own hardcoded default event) — a real value already resolved by
        // saveEvent/discovery must not be clobbered with that null just because the admin edited
        // an unrelated row's status.
        for (const next of Object.values(rebuilt)) {
          const previous = Object.values(season.events || {})
            .find(e => e.key === next.key || e.providerRef === next.providerRef);
          if (!previous) continue;
          Object.assign(next, { ...previous, ...next, config:{ ...(previous.config || {}), ...(next.config || {}) } });
          if (next.providerTeamId == null && previous.providerTeamId != null) next.providerTeamId = previous.providerTeamId;
        }
        season.seasonData = canonicalSeasonData(body.seasonData, rebuilt);
        season.events = rebuilt;
        const featured = Object.values(rebuilt).find(e => e.status === 'active' && e.providerRef);
        if (featured) season.featuredEventKey = featured.key;
        else if (!seasonIsComplete(season)) season.featuredEventKey = null;
        await writeSeason(season);
        return await done(scope, {
          count: body.seasonData.length,
          seasonOver:seasonIsComplete(season),
          frozenStats:season.finalStats || null,
        });
      }

      // ---- Delete one configured tournament and all of its scoped live layers ----
      case 'deleteEvent': {
        const deletingActive = season.featuredEventKey === event.key;
        delete season.events[event.key];
        season.seasonData = (season.seasonData || []).filter(row =>
          row.key !== event.key && row.providerRef !== event.providerRef);
        if (deletingActive) season.featuredEventKey = null;
        await deleteScopedEvent(scope);
        await writeSeason(season);
        return await done(scope, { deleted:event.key, deletedActive:deletingActive, season });
      }

      case 'completeSeason':
      case 'archiveSeason': // v2 admin compatibility
        if (seasonIsComplete(season)) {
          const existing = await readScopedArchive(context.teamKey, context.seasonKey);
          return json({ ok:true, alreadyCompleted:true, archiveVersion:season.archiveVersion, checksum:existing?.checksum });
        }
        return await completeSeason(req, context, false);

      case 'rebuildCompletedSeason':
      case 'replaceSeasonArchive':
        return await completeSeason(req, context, true);

      case 'reopenSeason':
        season.status = 'draft';
        season.featuredEventKey = null;
        await writeSeason(season);
        return await done(scope, { seasonOver:false, archiveVersion:season.archiveVersion || null });

      // ---- Tournament transition (switch the live event) ----
      case 'switchEvent': {
        // 200 + no `error` field, matching runSetup's confirmation response below — admin.html's
        // api() throws on any non-OK status or `data.error`, so a 409/error response here would
        // never let the caller reach `r.requiresConfirmation` to show the second confirm dialog.
        if (switchEventRequiresReopenConfirmation(season, body)) {
          return json({
            ok:true, requiresConfirmation:true,
            note:'season is completed — switching events would silently reopen it; resend with confirmReopen:true (or use "Reopen season" first)',
          });
        }
        const id = String(body.eventId || '').trim();
        const referencedEvent = Object.values(season.events || {})
          .find(item => item.providerRef === id);
        const ref = parseEventRef(id, team, referencedEvent?.providerTeamId);
        const nextEventKey = normalizeKey(
          body.newEventKey || referencedEvent?.key || keyFromName(body.eventName || id, 'event'),
          'event key',
        );
        const keyedEvent = season.events?.[nextEventKey];
        if (keyedEvent?.providerRef && keyedEvent.providerRef !== id) {
          return json({
            error:`event key "${nextEventKey}" already belongs to ${keyedEvent.providerRef}; use a new key`,
          }, 409);
        }
        if (referencedEvent && referencedEvent.key !== nextEventKey) {
          return json({
            error:`provider event ${id} already uses key "${referencedEvent.key}"`,
          }, 409);
        }
        // Discover immediately so the new event is live without waiting for the cron tick.
        // effectiveSelection(referencedEvent) carries over a previously saved detect/correct pick
        // (docs/tournament-setup-plan.md) if this provider ref was already added as a tournament;
        // a brand-new event has no discovery block and resolves to {} (age-prefix match, as before).
        const s = await buildProviderStructure(id, team, { providerTeamId: referencedEvent?.providerTeamId,
          previousStructure:await readStructure(id, {teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:nextEventKey}),
          selection:effectiveSelection(referencedEvent) });
        if (body.eventName) s.meta.name = String(body.eventName).trim();
        const next = season.events[nextEventKey] || {
          key:nextEventKey, name:body.eventName || s.meta.name, providerRef:id,
          providerTeamId:ref.providerTeamId || null, status:'active', config:{},
        };
        next.name = body.eventName || s.meta.name;
        next.providerRef = id;
        next.providerTeamId = ref.providerTeamId || next.providerTeamId || null;
        season.events[nextEventKey] = next;
        season.featuredEventKey = nextEventKey;
        for (const item of Object.values(season.events || {}))
          item.status = item.key === nextEventKey ? 'active' : item.status === 'active' ? 'completed' : item.status;
        if (seasonIsComplete(season)) season.status = 'draft';
        const previousRows = season.seasonData || [];
        previousRows.forEach(row => { if (row.status === 'now') row.status = 'done'; });
        const row = previousRows.find(item =>
          item.key === nextEventKey || item.providerRef === id
          || item.url === s.meta.sourceUrl);
        const nextRow = {
          ...(row || {}),
          key:nextEventKey,
          name:next.name,
          dates:row?.dates ?? formatSeasonDates(s.meta.dates),
          location:row?.location ?? s.meta.venue?.city ?? s.meta.venue?.name ?? '',
          status:'now',
          url:s.meta.sourceUrl || row?.url || null,
          providerRef:id,
          snapshotPath:next.snapshotPath || row?.snapshotPath || null,
        };
        if (row) Object.assign(row, nextRow);
        else previousRows.push(nextRow);
        season.seasonData = previousRows;
        const nextScope = { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:nextEventKey };
        await writeStructure(id, s, nextScope);
        await writeSeason(season);
        await bumpRev(nextScope);
        return json({ ok:true, activeEventId:id, activeEventKey:nextEventKey, name:s.meta.name, pools:s.poolOrder.length });
      }

      // ---- Read-only tournament detection (docs/tournament-setup-plan.md Phase 1) ----
      // Given a provider URL/id, returns what discovery can find (division, team, candidate
      // lists for the review form) without writing anything. NorCal only for now — AST/Tourney
      // Machine still go through switchEvent's single-shot discover-and-go-live flow.
      case 'detectEvent': {
        const providerRef = String(body.providerRef || body.url || '').trim();
        if (!providerRef) return json({ error:'providerRef (a tournament URL or id) required' }, 400);
        const kind = classifyProviderRef(providerRef);
        if (kind === 'norcal') {
          const eventId = (providerRef.match(/\/pages\/event\/(\d+)/) || [])[1] || providerRef;
          return json({ ok:true, ...(await detectNorcalEvent(eventId, team)) });
        }
        if (kind === 'tourneymachine') return json({ ok:true, ...(await detectTourneyMachineEvent(providerRef, team)) });
        if (kind === 'ast') return json({ ok:true, ...(await detectAstEvent(providerRef, team)) });
        return json({ error:'Enter a NorCal event URL/id, an AST event URL, or a Tourney Machine tournament/division URL.' }, 400);
      }

      // ---- Add/edit a tournament without making it live (docs/tournament-setup-plan.md) ----
      // Runs discovery (dispatched by classifyProviderRef) with the given `manual` corrections
      // layered on top of the last detection, saves the event record (with its own `discovery`
      // block for future rebuilds) and its structure — but does NOT touch featuredEventKey/season
      // status. Call makeEventLive separately to switch to it. Each provider gates saving
      // differently (see the branches below); NorCal/AST both support saving a "pending" shell
      // before the schedule/team-list is published (buildProviderStructure returns one), Tourney
      // Machine does not (there's no division to fetch without one).
      case 'saveEvent': {
        if (body.makeActive && seasonIsComplete(season))
          return json({ error:'Reopen this completed season before setting a tournament active.' }, 409);
        const rawProviderRef = String(body.providerRef || '').trim();
        if (!rawProviderRef) return json({ error:'providerRef required' }, 400);
        const manual = body.manual && typeof body.manual === 'object' ? body.manual : {};
        // Validate before any provider work or writes.
        let seedingRules;
        if (body.config && typeof body.config === 'object' && Object.hasOwn(body.config, 'seedingRules')) {
          try { seedingRules = normalizeSeedingRules(body.config.seedingRules); }
          catch (error) { return json({ error:error.message }, 400); }
        }
        const kind = classifyProviderRef(rawProviderRef);
        let providerRef = rawProviderRef, detected = {}, detectionProvider = kind;

        // Non-provider edit (name/dates/location/rules/weather/result on an existing tournament):
        // same key, same URL, same division/team corrections, no Detect run in the editor
        // (`redetected` — a fresh detection must be applied even when the picks match), and a
        // stored structure that isn't still waiting on a schedule — skip re-detection and the full
        // provider rebuild. Anything else rebuilds as before.
        const editing = body.existingEventKey ? season.events?.[body.existingEventKey] : null;
        const editingRow = editing && (season.seasonData || []).find(item => item.key === editing.key);
        const stored = editing?.providerRef && !body.redetected
          && normalizeKey(body.newEventKey || editing.key, 'event key') === editing.key
          && [editing.providerRef, editingRow?.url, editingRow?.providerRef].includes(rawProviderRef)
          && providerInputsUnchanged(manual, editing.discovery?.manual)
          ? await readStructure(editing.providerRef, { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:editing.key })
          : null;
        const reuse = stored && !stored.meta?.schedulePending ? stored : null;
        if (reuse) {
          providerRef = editing.providerRef;
          detected = editing.discovery?.detected || {};
        } else if (kind === 'norcal') {
          providerRef = (rawProviderRef.match(/\/pages\/event\/(\d+)/) || [])[1] || rawProviderRef;
          const detection = await detectNorcalEvent(providerRef, team);
          detected = detection.detected;
          if (detection.schedulePublished && !(manual.providerTeamId ?? detected.providerTeamId)) {
            return json({ error:'No team resolved for this tournament yet. Pick its division and team manually, or save again once the schedule is published.', detection }, 409);
          }
        } else if (kind === 'tourneymachine') {
          const detection = await detectTourneyMachineEvent(rawProviderRef, team);
          detected = detection.detected;
          const divisionId = manual.divisionIds?.[0] ?? detected.divisionIds?.[0] ?? null;
          const providerTeamId = manual.providerTeamId ?? detected.providerTeamId ?? null;
          if (!divisionId) {
            return json({ error: detection.schedulePublished
              ? 'Pick a division before saving — none resolved automatically.'
              : 'This tournament has no divisions published yet — check back once it does.', detection }, 409);
          }
          if (detection.schedulePublished && !providerTeamId) {
            return json({ error:'No team resolved for this tournament yet. Pick it manually, or save again once the schedule is published.', detection }, 409);
          }
          // Resolve to a fully-specified ref up front — later rebuilds no longer need to
          // re-search every division, just this one.
          providerRef = `tm:${detection.tournamentId}:${divisionId}${providerTeamId ? ':' + providerTeamId : ''}`;
        } else if (kind === 'ast') {
          const detection = await detectAstEvent(rawProviderRef, team);
          detected = detection.detected;
          providerRef = detection.providerRef;
          const region = manual.region ?? detected.region ?? null;
          const teamName = manual.teamName ?? detected.teamName ?? null;
          // Setup can't build without a region even before team lists are posted (parseAstRef
          // requires one) — unless the team's own astRegion (or the default team's) supplies it.
          const fallbackRegion = team.astRegion || null;
          if (!region && (detection.schedulePublished || !fallbackRegion)) {
            return json({ error:'Could not determine the AST region for this tournament. Pick one manually.', detection }, 409);
          }
          if (detection.schedulePublished && !teamName) {
            return json({ error:'No team resolved for this tournament yet. Pick it manually, or save again once the schedule is published.', detection }, 409);
          }
        } else {
          return json({ error:'Enter a NorCal event URL/id, an AST event URL, or a Tourney Machine tournament/division URL.' }, 400);
        }

        const nextEventKey = normalizeKey(body.newEventKey || keyFromName(body.name || providerRef, 'event'), 'event key');
        const suppliedDates = Object.hasOwn(body, 'startDate') || Object.hasOwn(body, 'endDate');
        const startDate = String(body.startDate || '').trim();
        const endDate = String(body.endDate || '').trim();
        if (suppliedDates && (startDate || endDate) &&
            (!validCalendarDate(startDate) || !validCalendarDate(endDate) || startDate > endDate))
          return json({ error:'Enter valid start and end calendar dates, with the end on or after the start.' }, 400);
        const existing = season.events?.[nextEventKey];
        const replacingProvider = existing?.providerRef && existing.providerRef !== providerRef
          && body.existingEventKey === nextEventKey;
        if (existing?.providerRef && existing.providerRef !== providerRef && !replacingProvider)
          return json({ error:`event key "${nextEventKey}" already belongs to ${existing.providerRef}; use a new key` }, 409);
        const selection = { ...detected, ...manual };
        const s = reuse || await buildProviderStructure(providerRef, team, {
          providerTeamId: selection.providerTeamId || (replacingProvider ? null : existing?.providerTeamId),
          previousStructure: replacingProvider ? null : await readStructure(providerRef, { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:nextEventKey }),
          selection,
        });
        const structureName = s.meta.name;
        if (body.name) s.meta.name = String(body.name).trim();
        const previousRows = season.seasonData || [];
        const row = previousRows.find(item =>
          item.key === nextEventKey || item.providerRef === providerRef || item.url === s.meta.sourceUrl);
        const rulesUrl = Object.hasOwn(body, 'rulesUrl')
          ? String(body.rulesUrl || '').trim()
          : existing?.config?.rulesUrl ?? detected.rulesUrl ?? s.meta.rulesUrl;
        const incomingConfig = body.config && typeof body.config === 'object' ? body.config : {};
        const nextConfig = { ...(existing?.config || {}), ...(rulesUrl != null ? { rulesUrl } : {}) };
        for (const key of ['accuweatherUrl', 'knownPlacement', 'venue'])
          if (Object.hasOwn(incomingConfig, key)) nextConfig[key] = incomingConfig[key];
        // null clears a saved rule set, back to the provider default (AST) or unverified.
        if (seedingRules !== undefined) nextConfig.seedingRules = seedingRules;
        // An admin-entered result is an override the score check must not replace; clearing it
        // falls back to the automatically captured placement, if there is one.
        if (Object.hasOwn(incomingConfig, 'knownPlacement')) {
          const previous = existing?.config?.knownPlacement;
          nextConfig.knownPlacement = incomingConfig.knownPlacement
            ? { ...incomingConfig.knownPlacement, source:'manual' }
            : nextConfig.autoPlacement || (isManualPlacement(previous) ? null : previous) || null;
        }
        const next = {
          ...(existing || {}),
          key:nextEventKey,
          name:body.name || s.meta.name,
          providerRef,
          providerTeamId:selection.providerTeamId || s.meta.providerTeamId || (replacingProvider ? null : existing?.providerTeamId) || null,
          status:existing?.status || 'upcoming',
          config:nextConfig,
          discovery:reuse ? existing.discovery
            : { detectedAt:new Date().toISOString(), provider:detectionProvider, detected, manual },
        };
        season.events = season.events || {};
        season.events[nextEventKey] = next;
        const nextRow = {
          ...(row || {}),
          key:nextEventKey,
          name:next.name,
          dates:startDate && endDate ? formatCalendarDates(startDate, endDate)
            : Object.hasOwn(body, 'dates') ? String(body.dates || '').trim()
            : row?.startDate && suppliedDates ? '' : row?.dates ?? formatSeasonDates(s.meta.dates),
          ...(startDate && endDate ? { startDate, endDate } : {}),
          location:Object.hasOwn(body, 'location') ? String(body.location || '').trim() : row?.location ?? s.meta.venue?.city ?? s.meta.venue?.name ?? '',
          status:row?.status || (next.status === 'active' ? 'now' : next.status === 'completed' ? 'done' : 'fut'),
          url:s.meta.sourceUrl || row?.url || null,
          providerRef,
          snapshotPath:next.snapshotPath || row?.snapshotPath || null,
        };
        if (row) Object.assign(row, nextRow); else previousRows.push(nextRow);
        if (suppliedDates && !startDate && !endDate && row?.startDate) {
          delete nextRow.startDate; delete nextRow.endDate;
          if (row) { delete row.startDate; delete row.endDate; }
        }
        season.seasonData = previousRows;
        if (body.makeActive) {
          season.featuredEventKey = nextEventKey;
          for (const item of Object.values(season.events || {}))
            item.status = item.key === nextEventKey ? 'active' : item.status === 'active' ? 'completed' : item.status;
          previousRows.forEach(item => { item.status = item.key === nextEventKey ? 'now' : item.status === 'now' ? 'done' : item.status; });
        }
        const nextScope = { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:nextEventKey };
        if (!reuse || s.meta.name !== structureName) await writeStructure(providerRef, s, nextScope);
        if (replacingProvider) await clearScopedEventLiveLayers(nextScope);
        await writeSeason(season);
        await bumpRev(nextScope);
        return json({
          ok:true, eventKey:nextEventKey, name:s.meta.name, pools:s.poolOrder.length,
          division:s.meta.division, schedulePending:!!s.meta.schedulePending, setupSkipped:!!reuse,
          activeEventKey:body.makeActive ? nextEventKey : season.featuredEventKey,
          season,
        });
      }

      // ---- Promote an already-saved tournament (via saveEvent) to the season's featured event ----
      case 'makeEventLive': {
        if (switchEventRequiresReopenConfirmation(season, body)) {
          return json({
            ok:true, requiresConfirmation:true,
            note:'season is completed — making a tournament live would silently reopen it; resend with confirmReopen:true (or use "Reopen season" first)',
          });
        }
        if (!event) return json({ error:'unknown event — save it first' }, 404);
        // Re-discover so a saved-but-stale tournament (schedule published since it was added, or
        // a correction saved after the last build) goes live with current data, not a stale copy.
        const s = await buildProviderStructure(event.providerRef, team, {
          providerTeamId: event.providerTeamId,
          previousStructure: await readStructure(event.providerRef, scope),
          selection: effectiveSelection(event),
        });
        season.featuredEventKey = event.key;
        for (const item of Object.values(season.events || {}))
          item.status = item.key === event.key ? 'active' : item.status === 'active' ? 'completed' : item.status;
        if (seasonIsComplete(season)) season.status = 'draft';
        const previousRows = season.seasonData || [];
        previousRows.forEach(row => { if (row.status === 'now') row.status = 'done'; });
        const row = previousRows.find(item =>
          item.key === event.key || item.providerRef === event.providerRef || item.url === s.meta.sourceUrl);
        const nextRow = {
          ...(row || {}), key:event.key, name:event.name, dates:row?.dates ?? formatSeasonDates(s.meta.dates),
          location:row?.location ?? s.meta.venue?.city ?? s.meta.venue?.name ?? '', status:'now',
          url:s.meta.sourceUrl || row?.url || null, providerRef:event.providerRef,
          snapshotPath:event.snapshotPath || row?.snapshotPath || null,
        };
        if (row) Object.assign(row, nextRow); else previousRows.push(nextRow);
        season.seasonData = previousRows;
        await writeStructure(event.providerRef, s, scope);
        await writeSeason(season);
        await bumpRev(scope);
        return json({ ok:true, activeEventId:event.providerRef, activeEventKey:event.key, name:s.meta.name, pools:s.poolOrder.length });
      }

      // ---- Re-run discovery for the current active event ----
      case 'runSetup': {
        const old = await readStructure(eventId, scope);
        const s = await buildProviderStructure(eventId, team, { providerTeamId: event?.providerTeamId, previousStructure:old, selection:effectiveSelection(event) });
        const changes = structureChanges(old, s);
        changes.replaced = s.meta?.provider === 'tourneymachine' ? changedTourneyMachineIdentities(old, s) : [];
        const currentOverrides = await readOverrides(eventId, scope);
        changes.orphanOverrides = changes.removed.filter(k => currentOverrides[k]);
        if ((changes.removed.length || changes.renumbered || changes.replaced.length) && !body.confirmRemovals)
          return json({ ok:true, requiresConfirmation:true, changes });
        if (changes.replaced.length) {
          const results = await readResults(eventId, scope);
          for (const key of changes.replaced) { delete results.games[key]; delete currentOverrides[key]; }
          for (const level of Object.keys(results.bracketGames))
            results.bracketGames[level] = results.bracketGames[level].filter(g => !changes.replaced.includes(g.key));
          results.standings = {}; results.poolsDone = {}; results.bracketsDone = {};
          await writeResults(eventId, results, scope);
          await writeOverrides(eventId, currentOverrides, scope);
        }
        await writeStructure(eventId, s, scope);
        await bumpRev(scope);
        return json({ ok: true, eventId, name: s.meta.name, pools: s.poolOrder.length, changes });
      }

      // ---- Manual NorCal score pull (forced — bypasses the cron's date window) ----
      case 'pullScores': {
        let structure = await readStructure(eventId, scope);
        if (!structure) {
          structure = await buildProviderStructure(eventId, team, { providerTeamId: event?.providerTeamId, selection:effectiveSelection(event) });
          await writeStructure(eventId, structure, scope);
        }
        const r = await runScoreCheck(eventId, structure, { force:true, context });
        await bumpRev(scope);
        return json({ ok: true, ...r });
      }

      // ---- Homerun Derby (per team + season: roster on the season record, board in its own store) ----
      case 'setMiniGameRoster': {
        let roster;
        try { roster = normalizeRoster(body.roster); } catch (e) { return json({ error:e.message }, 400); }
        season.miniGame = { ...(season.miniGame || {}), roster };
        await writeSeason(season);
        await bumpRev({ teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:context.eventKey });
        return json({ ok:true, roster, season });
      }
      case 'getMiniGameRoster':
        // Read-only: any cataloged team's season roster for the editor's import modal.
        return json({ ok:true, roster:effectiveRoster({ teamKey:context.teamKey, seasonKey:context.seasonKey, season }) });
      case 'resetHighScores': {
        await clearHighScores(context.teamKey, context.seasonKey, { markReset:true });
        return await done(scope, { highScoresReset:true, teamKey:context.teamKey, seasonKey:context.seasonKey });
      }

      // ---- Force a silent refresh of open tabs ----
      case 'refresh':
        return await done(scope, { refreshed: true });

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    if (e.code === 'catalogMigrationUnconfirmed') return json({ error:e.message, code:e.code }, 409);
    return json({ error: e.message }, 502);
  }
}

// Write actions reload open tabs by bumping the global rev token.
async function done(scope, extra) {
  const rev = await bumpRev(scope);
  return json({ ok: true, rev, ...extra });
}

async function clearHighScores(teamKeyValue, seasonKeyValue, { markReset = false } = {}) {
  const store = getStore('minigame-highscores');
  const { blobs } = await store.list({ prefix:scorePrefix(teamKeyValue, seasonKeyValue) });
  await Promise.all(blobs.map(blob => store.delete(blob.key)));
  await store.delete(boardCacheKey(teamKeyValue, seasonKeyValue));
  if (markReset) await store.setJSON(boardKey(teamKeyValue, seasonKeyValue), []);
  else await store.delete(boardKey(teamKeyValue, seasonKeyValue));
  if (!markReset && isDefaultMiniGameContext(teamKeyValue, seasonKeyValue)) {
    await store.delete(LEGACY_BOARD_KEY);
  }
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

// POST only: a function route otherwise wins over static files, so GET /admin would hit this
// handler (403 without ?key=) instead of serving admin.html.
export const config = { path: '/admin', method: 'POST' };

async function fetchHistoricalSnapshots(req, season, featuredEventKey) {
  const snapshots = {};
  for (const [key, event] of Object.entries(season.events || {})) {
    if (key === featuredEventKey || !event.providerRef) continue;
    const eventScope = { teamKey:season.teamKey, seasonKey:season.key, eventKey:key };
    const [structure, results, overrides] = await Promise.all([
      readStructure(event.providerRef, eventScope),
      readResults(event.providerRef, eventScope),
      readOverrides(event.providerRef, eventScope),
    ]);
    const scoped = mergeSnapshot(structure, results, overrides);
    if (scoped) {
      snapshots[key] = scoped;
      continue;
    }
    if (!event.snapshotPath) throw new Error(`no archived snapshot is available for ${event.name}`);
    const url = new URL('/' + event.snapshotPath.replace(/^\/+/, ''), req.url);
    const response = await fetch(url, { signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`could not load ${event.name} archive (${response.status})`);
    snapshots[key] = await response.json();
  }
  return snapshots;
}

function formatSeasonDates(dates = []) {
  if (!dates.length) return '';
  const parsed = dates.map(date => new Date(`${date}T12:00:00`));
  const first = parsed[0], last = parsed[parsed.length - 1];
  const month = first.toLocaleDateString('en-US', { month:'short' });
  return first.getMonth() === last.getMonth()
    ? `${month} ${first.getDate()}–${last.getDate()}`
    : `${month} ${first.getDate()}–${last.toLocaleDateString('en-US', { month:'short', day:'numeric' })}`;
}

async function completeSeason(req, context, replacement) {
  const { team, season, event, eventId, scope } = context;
  const [structure, results, overrides, historical] = await Promise.all([
    readStructure(eventId, scope),
    readResults(eventId, scope),
    readOverrides(eventId, scope),
    fetchHistoricalSnapshots(req, season, event.key),
  ]);
  const snapshot = mergeSnapshot(structure, results, overrides);
  if (!snapshot) return json({ error:'cannot complete season without a current tournament snapshot' }, 409);
  const capturedAt = new Date().toISOString();
  season.finalStats = freezeSeasonStats(snapshot, eventId, capturedAt, historical);
  const previousVersion = Number(season.archiveVersion || 0);
  // Reopening keeps old frozen versions. Completing that season again must therefore create the
  // next version even though it came through the normal Complete button, not the correction one.
  const archiveVersion = replacement || previousVersion > 0 ? previousVersion + 1 : 1;
  const bundle = createArchiveBundle({
    team, season, featuredEvent:event, featuredSnapshot:snapshot,
    eventSnapshots:historical, capturedAt, archiveVersion,
  });
  const existing = await readScopedArchive(team.key, season.key, archiveVersion);
  if (existing && existing.checksum !== bundle.checksum) {
    return json({ error:`snapshot v${archiveVersion} already exists; create a replacement version` }, 409);
  }
  if (!existing) await writeScopedArchive(bundle);
  // The completion snapshot stays in private Blob storage. Git export is intentionally not part
  // of the season lifecycle: changing the active season is enough to keep every completed season
  // addressable, and personal/team data must not be committed to the application repository.
  season.status = 'completed';
  season.completedAt = capturedAt;
  season.archiveVersion = archiveVersion;
  delete season.archiveExport;
  for (const item of Object.values(season.events || {})) if (item.status === 'active') item.status = 'completed';
  await writeSeason(season);
  return done(scope, {
    seasonOver:true, archiveVersion, checksum:bundle.checksum,
  });
}

async function setActiveContext(body) {
  const teamKey = normalizeKey(body.teamKey, 'team key');
  const seasonKey = normalizeKey(body.seasonKey, 'season key');
  const catalog = await ensureScopedModel();
  if (!catalog.teams?.[teamKey]?.seasons?.[seasonKey])
    return json({ error:'Unknown team or season.' }, 404);
  const selected = await readSeason(teamKey, seasonKey);
  if (!selected || seasonIsComplete(selected))
    return json({ error:'Reopen this completed season before setting it active.' }, 409);
  const featured = selected.events?.[selected.featuredEventKey];
  if (!featured?.providerRef)
    return json({ error:'Set a tournament active before making this team and season active.' }, 409);

  // Persist every lifecycle change before publishing the new site-wide default pointer.
  for (const [otherTeamKey, summary] of Object.entries(catalog.teams || {})) {
    for (const otherSeasonKey of Object.keys(summary.seasons || {})) {
      if (otherTeamKey === teamKey && otherSeasonKey === seasonKey) continue;
      const other = await readSeason(otherTeamKey, otherSeasonKey);
      if (other?.status !== 'active') continue;
      other.status = 'draft';
      await writeSeason(other);
      await bumpRev({ teamKey:otherTeamKey, seasonKey:otherSeasonKey, eventKey:other.featuredEventKey });
    }
  }
  selected.status = 'active';
  await writeSeason(selected);
  await bumpRev({ teamKey, seasonKey, eventKey:selected.featuredEventKey });
  const team = await readTeam(teamKey);
  team.defaultSeasonKey = seasonKey;
  await writeTeam(team);
  const latestCatalog = await readCatalog();
  latestCatalog.defaultTeamKey = teamKey;
  latestCatalog.teams[teamKey].defaultSeasonKey = seasonKey;
  await writeCatalog(latestCatalog);
  return json({ ok:true, activeTeamKey:teamKey, activeSeasonKey:seasonKey,
    activeEventKey:selected.featuredEventKey, catalog:publicCatalog(latestCatalog) });
}

async function createTeam(body) {
  const catalog = await ensureScopedModel();
  const key = normalizeKey(body.team?.key || body.teamKey, 'team key');
  if (catalog.teams?.[key]) return json({ error:`team already exists: ${key}` }, 409);
  const norcalTeamId = body.team?.norcalTeamId ? String(body.team.norcalTeamId).trim() : null;
  // Every team needs a canonical team id for live provider discovery — buildProviderStructure
  // throws for both NorCal and Tourney Machine events without one — and there's no separate "edit team"
  // action to add it after the fact, so a team created without one would be permanently unable to
  // switch to or load any event. Reject at creation instead of leaving a bricked team in the catalog.
  if (!norcalTeamId) {
    return json({ error:'norcalTeamId is required for live provider discovery' }, 400);
  }
  const team = {
    schemaVersion:2, key,
    name:String(body.team?.name || body.name || key).trim(),
    shortName:String(body.team?.shortName || body.team?.name || body.name || key).trim(),
    subtitle:String(body.team?.subtitle || '').trim() || null,
    defaultSeasonKey:null,
    norcalTeamId,
    sisterTeamId:body.team?.sisterTeamId || null,
    agePrefix:String(parseAge(body.team?.agePrefix) ?? 10),
    // AST/Tourney Machine identity defaults — only meaningful for a team that plays AST events;
    // a per-tournament `discovery.manual.region`/`teamName` correction (saveEvent) overrides
    // these, so they only need to be right "most of the time". See lib/ast.js parseAstRef.
    astTeamName:body.team?.astTeamName ? String(body.team.astTeamName).trim() : null,
    astRegion:body.team?.astRegion ? String(body.team.astRegion).trim() : null,
    tourneyMachineTeamName:body.team?.tourneyMachineTeamName ? String(body.team.tourneyMachineTeamName).trim() : null,
    logoUrl:body.team?.logoUrl || null,
  };
  await writeTeam(team);
  catalog.teams = catalog.teams || {};
  catalog.teams[key] = { key, name:team.name, defaultSeasonKey:null, seasons:{} };
  await writeCatalog(catalog);
  return json({ ok:true, team });
}

async function createSeason(body) {
  const catalog = await ensureScopedModel();
  const teamKey = normalizeKey(body.teamKey, 'team key');
  const summary = catalog.teams?.[teamKey];
  if (!summary) return json({ error:`unknown team: ${teamKey}` }, 404);
  const key = normalizeKey(body.season?.key || body.seasonKey, 'season key');
  if (await readSeason(teamKey, key)) return json({ error:`season already exists: ${key}` }, 409);
  const season = {
    schemaVersion:2, teamKey, key,
    name:String(body.season?.name || body.name || key).trim(),
    status:'draft', featuredEventKey:null, seasonData:[], finalStats:null,
    archiveVersion:null, teamConfig:{}, events:{},
  };
  await writeSeason(season);
  summary.seasons = summary.seasons || {};
  summary.seasons[key] = { key, name:season.name, status:season.status };
  if (!summary.defaultSeasonKey) {
    summary.defaultSeasonKey = key;
    const team = await readTeam(teamKey);
    team.defaultSeasonKey = key;
    await writeTeam(team);
  }
  await writeCatalog(catalog);
  return json({ ok:true, season });
}

// Edit a team's fields in place. The team KEY is immutable (it's the storage path + catalog key);
// to change a key you delete + recreate. Only fields present in body.team are touched.
async function updateTeam(body) {
  const catalog = await ensureScopedModel();
  const key = normalizeKey(body.teamKey || body.team?.key, 'team key');
  const team = await readTeam(key);
  if (!team) return json({ error:`unknown team: ${key}` }, 404);
  const patch = body.team || {};
  if (patch.name != null && String(patch.name).trim()) team.name = String(patch.name).trim();
  if (patch.shortName != null) team.shortName = String(patch.shortName).trim() || team.name;
  if ('subtitle' in patch) team.subtitle = String(patch.subtitle || '').trim() || null;
  if ('norcalTeamId' in patch) team.norcalTeamId = patch.norcalTeamId ? String(patch.norcalTeamId).trim() : null;
  if ('sisterTeamId' in patch) team.sisterTeamId = patch.sisterTeamId ? String(patch.sisterTeamId).trim() : null;
  if (patch.agePrefix != null && parseAge(patch.agePrefix) != null) team.agePrefix = String(parseAge(patch.agePrefix));
  if ('astTeamName' in patch) team.astTeamName = patch.astTeamName ? String(patch.astTeamName).trim() : null;
  if ('astRegion' in patch) team.astRegion = patch.astRegion ? String(patch.astRegion).trim() : null;
  if ('tourneyMachineTeamName' in patch) team.tourneyMachineTeamName = patch.tourneyMachineTeamName ? String(patch.tourneyMachineTeamName).trim() : null;
  if ('logoUrl' in patch) team.logoUrl = patch.logoUrl ? String(patch.logoUrl).trim() : null;
  // Same invariant createTeam enforces.
  if (!team.norcalTeamId) {
    return json({ error:'norcalTeamId is required for live provider discovery' }, 400);
  }
  await writeTeam(team);
  // Keep the catalog summary's display name in sync (it carries a copy).
  if (catalog.teams?.[key] && catalog.teams[key].name !== team.name) {
    catalog.teams[key].name = team.name;
    await writeCatalog(catalog);
  }
  return json({ ok:true, team });
}

// Delete a team and everything scoped under it (seasons + their per-event L1/L2/L3 layers, season
// rev tokens, and archive versions), then drop it from the catalog. Refuses the default team — the
// public root resolves to it, so deleting it would brick the site until a new default were set
// (and there's no set-default action yet).
async function deleteTeam(body) {
  const catalog = await ensureScopedModel();
  const key = normalizeKey(body.teamKey || body.team?.key, 'team key');
  const summary = catalog.teams?.[key];
  if (!summary) return json({ error:`unknown team: ${key}` }, 404);
  if (key === catalog.defaultTeamKey) {
    return json({ error:`cannot delete the default team "${key}" — it is what the site root resolves to; set a different default first` }, 409);
  }
  for (const seasonKeyValue of Object.keys(summary.seasons || {})) {
    const season = await readSeason(key, seasonKeyValue);
    for (const eventKey of Object.keys(season?.events || {})) {
      await deleteScopedEvent({ teamKey:key, seasonKey:seasonKeyValue, eventKey });
    }
    for (let v = 1; v <= Number(season?.archiveVersion || 0); v++) {
      await deleteArchiveRecord(key, seasonKeyValue, v);
    }
    await deleteSeasonRev(key, seasonKeyValue);
    await clearHighScores(key, seasonKeyValue);
    await deleteSeasonRecord(key, seasonKeyValue);
  }
  await deleteTeamRecord(key);
  delete catalog.teams[key];
  await writeCatalog(catalog);
  return json({ ok:true, deleted:key });
}

// Rename a season (the season KEY is immutable, like a team key). writeSeason re-syncs the
// catalog summary's name/status copy.
async function updateSeason(body) {
  const teamKeyValue = normalizeKey(body.teamKey || body.team?.key, 'team key');
  const key = normalizeKey(body.seasonKey || body.season?.key, 'season key');
  const season = await readSeason(teamKeyValue, key);
  if (!season) return json({ error:`unknown season: ${key}` }, 404);
  const patch = body.season || {};
  if (patch.name != null && String(patch.name).trim()) season.name = String(patch.name).trim();
  await writeSeason(season);
  return json({ ok:true, season });
}

// Delete one season and everything under it (per-event layers, rev, archives), then drop it from
// the catalog. Repoints the team's default season if we removed it. Refuses to remove the default
// team's LAST season — the site root resolves to that team and would have nothing to show.
async function deleteSeason(body) {
  const catalog = await ensureScopedModel();
  const teamKeyValue = normalizeKey(body.teamKey || body.team?.key, 'team key');
  const key = normalizeKey(body.seasonKey || body.season?.key, 'season key');
  const summary = catalog.teams?.[teamKeyValue];
  if (!summary?.seasons?.[key]) return json({ error:`unknown season: ${key}` }, 404);
  const remaining = Object.keys(summary.seasons).filter(k => k !== key);
  if (teamKeyValue === catalog.defaultTeamKey && remaining.length === 0) {
    return json({ error:`cannot delete the last season of the default team "${teamKeyValue}" — the site root would have nothing to show` }, 409);
  }
  const season = await readSeason(teamKeyValue, key);
  for (const eventKey of Object.keys(season?.events || {})) {
    await deleteScopedEvent({ teamKey:teamKeyValue, seasonKey:key, eventKey });
  }
  for (let v = 1; v <= Number(season?.archiveVersion || 0); v++) {
    await deleteArchiveRecord(teamKeyValue, key, v);
  }
  await deleteSeasonRev(teamKeyValue, key);
  await clearHighScores(teamKeyValue, key);
  await deleteSeasonRecord(teamKeyValue, key);
  delete summary.seasons[key];
  if (summary.defaultSeasonKey === key) {
    const next = remaining[0] || null;
    summary.defaultSeasonKey = next;
    const team = await readTeam(teamKeyValue);
    if (team) { team.defaultSeasonKey = next; await writeTeam(team); }
  }
  await writeCatalog(catalog);
  return json({ ok:true, deleted:key });
}

export { freezeSeasonStats };
// Moved to lib/providers.js (the cron's NorCal schedule refresh uses it too); re-exported for callers/tests.
export { structureChanges };

// switchEvent silently reopens a completed season (resuming live cron score polling) unless the
// caller explicitly acknowledges that with confirmReopen:true. Pulled out as a pure predicate
// so it's unit-testable without a request/Blobs harness.
// Which provider's detect()/save path a raw providerRef input belongs to, for detectEvent/
// saveEvent (docs/tournament-setup-plan.md). Deliberately looser than parseEventRef — it must
// also recognize a bare Tourney Machine TOURNAMENT-level URL (no IDDivision, ambiguous — that's
// exactly the case detectTourneyMachineEvent exists to resolve) and a NorCal event PAGE url, not
// just the already-fully-specified refs parseEventRef accepts.
// saveEvent's "did the admin change anything provider-side?" test for the division/team/region
// corrections. Key and array order don't matter, but presence does: an explicit empty list
// (e.g. "no sister divisions") overrides detection, while an absent field follows it — so this
// is deliberately stricter than selectionHash, which treats the two alike.
export function providerInputsUnchanged(manual, storedManual) {
  const canonical = value => JSON.stringify(Object.keys(value || {}).sort()
    .filter(key => value[key] !== undefined)
    .map(key => [key, Array.isArray(value[key]) ? [...value[key]].map(String).sort() : value[key]]));
  return canonical(manual) === canonical(storedManual);
}

export function classifyProviderRef(value) {
  const v = String(value || '').trim();
  if (/^\d+$/.test(v) || /\/pages\/event\/(\d+)/.test(v)) return 'norcal';
  if (/^https:\/\/(?:www\.)?allstartournaments\.com\//i.test(v)) return 'ast';
  if (/^tm:/.test(v) || /tourneymachine\.com/i.test(v)) return 'tourneymachine';
  return null;
}

export function switchEventRequiresReopenConfirmation(season, body) {
  return seasonIsComplete(season) && !body?.confirmReopen;
}
