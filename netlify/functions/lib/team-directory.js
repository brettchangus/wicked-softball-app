// Shared opponent identities. Tournament assignments remain in their scoped event config.
import { createHash, randomUUID } from 'node:crypto';
import { gameChangerNameKey, gameChangerOpponents, resolvedGameChangerLinks } from './gamechanger.js';
import { divisionAges, parseAge } from './divisions.js';
import { effectiveSelection } from './context.js';
import { gameChangerSeason, gameChangerNameParts } from './gamechanger-search.js';
import { providerTeamLocations, opponentRows } from './opponents.js';
import {
  readDirectoryEntries, writeDirectoryEntry, readDirectorySeed, writeDirectorySeed,
  readSeason, writeSeason, readTeam, readStructure, readGameChangerRecords, readCatalog, bumpRev,
} from './snapshot.js';

export function directoryProfileUrl(value) {
  if (!value) return '';
  const match = /^https:\/\/web\.gc\.com\/teams\/([\w-]+)(?:[/?#]|$)/i.exec(String(value).trim());
  if (!match) throw new Error('Use a https://web.gc.com/teams/... profile URL.');
  return `https://web.gc.com/teams/${match[1]}`;
}

// Calendar season, independent of each dashboard team's arbitrary season key.
export function directoryPeriod(context, structure) {
  const date = structure?.meta?.dates?.[0]
    || context.season?.seasonData?.find(row => row.key === context.eventKey)?.startDate;
  const configuredSeason = /\b(spring|summer|fall)\b/i.exec(`${context.season?.name || ''} ${context.season?.key || ''}`)?.[1]?.toLowerCase();
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `${date.slice(0, 4)}-${configuredSeason || gameChangerSeason(date)}` : null;
}

// A named opponent may play a different age from our team's fallback setting.
// Prefer its own age, then the saved tournament selection and published division.
function directoryTeamAge(context, structure, name) {
  const singleAge = value => {
    const ages = divisionAges(value);
    return ages.length === 1 ? ages[0] : null;
  };
  return singleAge(name) || parseAge(effectiveSelection(context.event).age)
    || singleAge(structure?.meta?.division) || singleAge(structure?.meta?.ast?.divisionLabel)
    || parseAge(context.team?.agePrefix);
}

export function normalizeDirectoryEntry(input, previous = null) {
  const text = value => String(value || '').trim().slice(0, 160);
  const name = text(input.name);
  if (!name) throw new Error('Directory team name is required.');
  const aliases = [...new Set([name, ...(Array.isArray(input.aliases) ? input.aliases : [])]
    .map(text).filter(Boolean))].slice(0, 100);
  const profiles = { ...(previous?.profiles || {}) };
  if (input.period != null) {
    if (!/^\d{4}-(spring|summer|fall)$/.test(input.period)) throw new Error('Choose a profile year and season.');
    profiles[input.period] = directoryProfileUrl(input.url);
  }
  return { id:previous?.id || randomUUID(), name, aliases, coach:text(input.coach),
    city:text(input.city), state:text(input.state), age:parseAge(input.age), profiles,
    identities:previous?.identities || [], sources:previous?.sources || [],
    updatedAt:new Date().toISOString() };
}

export function directoryIdentity(context, structure, teamId) {
  // TM ids are scoped to a tournament. AST registration names are aliases, never stable ids.
  if (String(teamId).startsWith('name:')) return null;
  if (structure?.meta?.provider === 'norcal') return `norcal:${teamId}`;
  if (structure?.meta?.provider === 'tourneymachine')
    return `tm:${structure.meta.eventId || context.event?.providerRef}:${teamId}`;
  return null;
}

// Whether a saved assignment pins this team's directory choice (an entry or an explicit "no
// match"). Tournament-link overrides and deleted-team markers leave matching to the usual rules.
export function directorySelection(assignment) {
  return !!assignment && !assignment.override && !assignment.deletedEntryId;
}

export function matchDirectory(context, structure, entries, saved = context.event?.config?.gameChangerTeams || {}) {
  const period = directoryPeriod(context, structure);
  // Wrap values so a name-keyed explicit null also follows the team when its schedule publishes.
  const links = Object.fromEntries(Object.entries(resolvedGameChangerLinks(structure,
    Object.fromEntries(Object.entries(saved || {}).map(([key, value]) => [key, { value }]))))
    .map(([key, row]) => [key, row.value]));
  const assignments = resolvedGameChangerLinks(structure, context.event?.config?.directoryMatches || {});
  const matches = {};
  const entriesById = new Map(entries.map(entry => [entry.id, entry]));
  const published = gameChangerOpponents(structure);
  const nameKey = name => gameChangerNameKey(String(name).replace(/\b(?:\d{1,2}\s*U|U\s*\d{1,2})\b/gi, ''));
  const registrationNames = resolvedGameChangerLinks(structure, Object.fromEntries(
    (structure?.meta?.ast?.teams || []).map(name => [gameChangerNameKey(name), name])));
  const locations = providerTeamLocations(structure);
  const aliasesByEntry = new Map(entries.map(entry => [entry.id, resolvedGameChangerLinks(structure,
    Object.fromEntries((entry.aliases || []).map(name => [gameChangerNameKey(name), entry.id])))]));
  for (const team of published) {
    const id = team.teamId;
    const identity = directoryIdentity(context, structure, id);
    const age = directoryTeamAge(context, structure, team.name);
    const identityHits = identity ? entries.filter(entry => entry.identities?.includes(identity)) : [];
    const coach = gameChangerNameParts(registrationNames[id] || team.name).coach;
    const location = locations[id] || {};
    const agrees = (a, b) => !a || !b || gameChangerNameKey(a) === gameChangerNameKey(b);
    const aliasHits = entries.filter(entry => (!age || !entry.age || entry.age === age)
      && agrees(entry.coach, coach) && agrees(entry.city, location.city) && agrees(entry.state, location.state)
      && (Object.hasOwn(aliasesByEntry.get(entry.id), id)
        || ((entry.aliases || []).some(name => nameKey(name) === nameKey(team.name))
          && published.filter(row => nameKey(row.name) === nameKey(team.name)).length === 1)));
    const candidates = identityHits.length ? identityHits : aliasHits;
    // A deleted directory team leaves a marker that hides only the link it cleared, so the team
    // can still automatch a live entry or take a newly saved link.
    const clearedLink = !!assignments[id]?.deletedEntryId && !!links[id] && links[id] === assignments[id].clearedUrl;
    let entry = null, basis = 'unmatched';
    if (directorySelection(assignments[id])) {
      entry = entriesById.get(assignments[id]?.entryId) || null;
      basis = assignments[id]?.entryId ? 'confirmed' : 'unmatched';
      links[id] = entry?.profiles?.[period] || null;
    } else if (Object.hasOwn(links, id) && !clearedLink) {
      // Explicit links and null removals always win over automatic matching.
      let url = '';
      try { url = directoryProfileUrl(links[id]); } catch {}
      const known = url ? entries.filter(row => row.profiles?.[period] === url) : [];
      entry = known.length === 1 ? known[0] : null;
      basis = links[id] ? 'tournament' : 'unmatched';
    } else if (candidates.length === 1) {
      entry = candidates[0];
      basis = identityHits.length ? 'provider' : 'alias';
      links[id] = entry.profiles?.[period] || null;
    } else if (candidates.length > 1) basis = 'ambiguous';
    // Report the cleared team's link as removed until it matches or is linked again.
    if (assignments[id]?.deletedEntryId && !entry && (clearedLink || !Object.hasOwn(links, id))) links[id] = null;
    matches[id] = { entryId:entry?.id || null, name:entry?.name || null, basis,
      candidates:candidates.map(row => row.id), period };
  }
  const teams = Object.fromEntries(Object.entries(matches).filter(([, match]) => match.entryId)
    .map(([id, match]) => [id, entriesById.get(match.entryId)]));
  const names = Object.fromEntries(Object.entries(matches)
    .filter(([id, match]) => links[id] && match.name && match.basis !== 'tournament').map(([id, match]) => [id, match.name]));
  return { links, matches, period, names, teams };
}

/** @param {Array<any>|null} [entries] Request-scoped directory data, when already loaded. */
export async function loadDirectoryMatches(context, structure, saved = undefined, entries = null) {
  return matchDirectory(context, structure, entries || await readDirectoryEntries(), saved);
}

// A new confirmed link entered in the existing Opponents editor also teaches the directory.
export async function rememberDirectoryLink(context, structure, teamId, rawUrl) {
  const period = directoryPeriod(context, structure);
  if (!period) return; // The explicit tournament link remains usable without calendar dates.
  const url = directoryProfileUrl(rawUrl);
  const entries = await readDirectoryEntries();
  const known = entries.filter(row => row.profiles?.[period] === url);
  if (known.length > 1) return; // Conflicting directory identities need an admin decision.
  const opponent = gameChangerOpponents(structure).find(row => row.teamId === teamId);
  if (!opponent) return;
  const registered = resolvedGameChangerLinks(structure, Object.fromEntries(
    (structure?.meta?.ast?.teams || []).map(name => [gameChangerNameKey(name), name])))[teamId];
  const display = opponentRows(structure, context.event?.config?.opponents).find(row => row.teamId === teamId);
  const entry = known[0] || normalizeDirectoryEntry({ name:display?.name || opponent.name,
    age:directoryTeamAge(context, structure, opponent.name),
    coach:display?.coach || gameChangerNameParts(registered || opponent.name).coach,
    city:display?.city, state:display?.state, period, url });
  entry.aliases = [...new Set([...(entry.aliases || []), opponent.name, registered].filter(Boolean))];
  const identity = directoryIdentity(context, structure, teamId);
  if (identity) entry.identities = [...new Set([...(entry.identities || []), identity])];
  entry.updatedAt = new Date().toISOString();
  await writeDirectoryEntry(entry);
  await invalidateDirectoryContexts();
}

export async function invalidateDirectoryContexts() {
  const catalog = await readCatalog();
  await Promise.all(Object.entries(catalog?.teams || {}).flatMap(([teamKey, team]) =>
    Object.keys(team.seasons || {}).map(seasonKey => bumpRev({ teamKey, seasonKey }))));
}

// Limit outbound reads/writes and wait for in-flight jobs before reporting a failure.
async function mapConcurrent(items, limit, work) {
  const results = new Array(items.length);
  let next = 0, stopped = false;
  const workers = Array.from({ length:Math.min(limit, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]); }
      catch (error) { stopped = true; throw error; }
    }
  });
  const finished = await Promise.allSettled(workers);
  const failure = finished.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

// Retain a tombstone so a later import cannot recreate a deleted team from old saved URLs.
// Remove directory associations only; schedules, results, and class overrides stay intact.
// Each cleared team gets a marker that hides the link it had, without pinning it as unmatched.
export async function deleteDirectoryTeam(entry) {
  const catalog = await readCatalog();
  const entries = await readDirectoryEntries();
  const teams = await mapConcurrent(Object.entries(catalog?.teams || {}), 4,
    async ([teamKey, summary]) => ({ teamKey, summary, team:await readTeam(teamKey) }));
  const seasons = await mapConcurrent(teams.flatMap(({ teamKey, summary, team }) =>
    Object.keys(summary.seasons || {}).map(seasonKey => ({ teamKey, seasonKey, team }))), 4,
    async item => ({ ...item, season:await readSeason(item.teamKey, item.seasonKey), removals:new Map() }));
  const events = seasons.flatMap(owner => Object.entries(owner.season?.events || {})
    .map(([eventKey, event]) => ({ owner, eventKey, event })));
  // Finish the read-only scan before any season is changed.
  await mapConcurrent(events, 6, async ({ owner, eventKey, event }) => {
    const { teamKey, seasonKey, team, season } = owner;
    const structure = await readStructure(event.providerRef, { teamKey, seasonKey, eventKey });
    const assignments = resolvedGameChangerLinks(structure, event.config?.directoryMatches || {});
    const directory = matchDirectory({ team, season, event, eventKey }, structure, entries);
    const ids = new Set(Object.entries(directory.matches)
      .filter(([id, match]) => match.entryId === entry.id && !assignments[id]?.override).map(([id]) => id));
    for (const [id, match] of Object.entries(event.config?.directoryMatches || {}))
      if (match?.entryId === entry.id && !assignments[id]?.override) ids.add(id);
    if (ids.size) owner.removals.set(eventKey, { ids, structure });
  });
  // Attempt every season, so one failed write doesn't leave the rest of the cleanup undone.
  const results = await mapConcurrent(seasons.filter(owner => owner.removals.size), 4, owner =>
    clearDeletedMatches(owner, entry, entries).then(unlinked => ({ unlinked }), error => ({ error })));
  const failed = results.filter(result => result.error);
  if (failed.length) {
    // The entry stays live so Delete can be retried; refresh tabs for the seasons already cleared.
    if (failed.length < results.length) await invalidateDirectoryContexts();
    throw new Error(`${failed.length} season${failed.length === 1 ? '' : 's'} could not be updated `
      + `(${failed[0].error.message}). The directory team was kept; delete it again to finish.`);
  }
  await writeDirectoryEntry({ ...entry, deletedAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  await invalidateDirectoryContexts();
  return { unlinked:results.reduce((sum, result) => sum + result.unlinked, 0) };
}

// One season's cleanup for deleteDirectoryTeam, re-reading it immediately before editing so
// newly saved links and match choices are preserved.
async function clearDeletedMatches({ teamKey, seasonKey, team, removals }, entry, entries) {
  const latest = await readSeason(teamKey, seasonKey);
  if (!latest) return 0;
  let unlinked = 0;
  for (const [eventKey, { ids, structure }] of removals) {
    const event = latest.events?.[eventKey];
    if (!event) continue;
    const assignments = resolvedGameChangerLinks(structure, event.config?.directoryMatches || {});
    const savedLinks = resolvedGameChangerLinks(structure, event.config?.gameChangerTeams || {});
    const current = matchDirectory({ team, season:latest, event, eventKey }, structure, entries);
    for (const id of ids) {
      const explicit = assignments[id];
      if (explicit?.override || (explicit?.entryId && explicit.entryId !== entry.id)) continue;
      if (explicit?.entryId !== entry.id && current.matches[id]?.entryId !== entry.id) continue;
      event.config ||= {};
      event.config.directoryMatches = { ...(event.config.directoryMatches || {}),
        [id]:{ entryId:null, deletedEntryId:entry.id, ...(savedLinks[id] ? { clearedUrl:savedLinks[id] } : {}) } };
      unlinked++;
    }
  }
  if (unlinked) await writeSeason(latest);
  return unlinked;
}

// Import one effective association per tournament team. Retained name keys are aliases,
// not separate profiles when a published id has a corrected link or an explicit removal.
function directorySeedTeams(context, structure, entries) {
  const saved = context.event.config?.gameChangerTeams || {};
  const effective = matchDirectory(context, structure, entries, saved).links;
  const opponents = gameChangerOpponents(structure);
  const rows = new Map(opponents.map(team => [team.teamId, {
    teamId:team.teamId, name:team.name, aliases:[team.name], url:effective[team.teamId],
  }]));
  const registered = new Map((structure?.meta?.ast?.teams || []).map(name => [gameChangerNameKey(name), name]));
  const keys = new Set([...Object.keys(saved), ...registered.keys()]);
  for (const key of keys) {
    const mapped = resolvedGameChangerLinks(structure, { [key]:true });
    const targets = opponents.filter(team => Object.hasOwn(mapped, team.teamId));
    const target = targets.length === 1 ? rows.get(targets[0].teamId) : null;
    const name = registered.get(key) || context.event.config?.gameChangerTeamNames?.[key];
    if (target) {
      const alias = registered.get(key);
      if (alias && !target.aliases.includes(alias)) target.aliases.push(alias);
    } else if (Object.hasOwn(saved, key)) {
      // A registered team omitted from the published schedule can still have a saved link.
      rows.set(key, { teamId:key, name, aliases:name ? [name] : [], url:effective[key] });
    }
  }
  return [...rows.values()].filter(team => team.url);
}

// Runs once on the first admin load after deployment; repeat imports are safe. No provider fetches.
// Group by confirmed GC profile + calendar season, never by a possibly ambiguous team name.
export async function seedTeamDirectory(catalog, { force = false } = {}) {
  if (!force && await readDirectorySeed()) return { imported:0 };
  const entries = await readDirectoryEntries({ includeDeleted:true });
  const byId = new Map(entries.map(row => [row.id, row]));
  const pending = new Map();
  const skipped = [];
  for (const [teamKey, summary] of Object.entries(catalog.teams || {})) {
    const team = await readTeam(teamKey);
    for (const seasonKey of Object.keys(summary.seasons || {})) {
      const season = await readSeason(teamKey, seasonKey);
      for (const [eventKey, event] of Object.entries(season?.events || {})) {
        if (!Object.values(event.config?.gameChangerTeams || {}).some(Boolean)) continue;
        const scope = { teamKey, seasonKey, eventKey };
        const structure = await readStructure(event.providerRef, scope);
        const context = { team, season, event, eventKey };
        const period = directoryPeriod(context, structure);
        if (!period) { skipped.push({ teamKey, seasonKey, eventKey, reason:'Missing tournament dates' }); continue; }
        const profiles = await readGameChangerRecords(scope);
        for (const row of directorySeedTeams(context, structure, entries.filter(entry => !entry.deletedAt))) {
          const teamId = row.teamId;
          const url = directoryProfileUrl(row.url);
          if (entries.some(row => row.profiles?.[period] === url)) continue;
          const id = 'seed-' + createHash('sha256').update(`${period}:${url}`).digest('hex').slice(0, 24);
          if (byId.has(id)) continue;
          const name = row.name || event.config.gameChangerTeamNames?.[teamId]
            || profiles[teamId]?.name || (teamId.startsWith('name:') ? teamId.slice(5) : `Team ${teamId}`);
          const entry = pending.get(id) || { id, name, coach:gameChangerNameParts(name).coach, city:profiles[teamId]?.location?.city || '',
            state:profiles[teamId]?.location?.state || '', age:directoryTeamAge(context, structure, name),
            aliases:[], identities:[], profiles:{ [period]:url }, sources:[], updatedAt:new Date().toISOString() };
          if (!entry.age) entry.age = directoryTeamAge(context, structure, name);
          entry.aliases = [...new Set([...entry.aliases, name, ...row.aliases])];
          const identity = directoryIdentity(context, structure, teamId);
          if (identity && !entry.identities.includes(identity)) entry.identities.push(identity);
          const source = `${teamKey}/${seasonKey}/${eventKey}`;
          if (!entry.sources.includes(source)) entry.sources.push(source);
          pending.set(id, entry);
        }
      }
    }
  }
  for (const entry of pending.values()) await writeDirectoryEntry(entry);
  await writeDirectorySeed({ skipped });
  if (pending.size) await invalidateDirectoryContexts();
  return { imported:pending.size, skipped };
}
