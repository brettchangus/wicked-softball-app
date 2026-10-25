// The one place a tournament's team display map is assembled from stored data, so the snapshot,
// the chat context and push text all resolve names, coaches and locations from the same inputs
// (see lib/opponents.js for the rules). Kept apart from opponents.js, which stays pure.
import { loadDirectoryMatches } from './team-directory.js';
import { readDirectoryEntries, readGameChangerRecords } from './snapshot.js';
import { gameChangerLinksForContext, resolvedGameChangerLinks } from './gamechanger.js';
import { locationsForGameChangerLinks } from './gamechanger-records.js';
import { editedTeamLabels, teamDisplayMap } from './opponents.js';

// `opponents` / `links` are the event config's overrides and GameChanger links; `ownUrl` is our
// own team's profile link. Pass `profiles` when the saved GameChanger profiles are already loaded.
export async function loadTeamDisplay(scope, structure, { opponents = {}, links = {}, ownUrl = '', profiles = null, context = null, directoryTeams = {}, directoryEntries = null } = {}) {
  const directory = context ? await loadDirectoryMatches(context, structure, links, directoryEntries) : null;
  const resolved = directory?.links || resolvedGameChangerLinks(structure, gameChangerLinksForContext(null, links));
  const ownId = structure?.meta?.providerTeamId;
  if (ownId && ownUrl) resolved[ownId] = ownUrl;
  const saved = profiles || (scope ? await readGameChangerRecords(scope) : {});
  return teamDisplayMap(structure, opponents, locationsForGameChangerLinks(resolved, saved), directory?.teams || directoryTeams);
}

// The season's game history (`wicked.games`) names opponents as the provider did. Returns
// { eventId: { teamId: label } } for the season's other tournaments, including shared directory
// names. `servedEvents` may be frozen (a completed season's bundle); `liveEvents` are
// the season's current records, whose edits win since they can be corrected after archival.
// `loadSnapshot(key, item, index)` supplies a tournament's snapshot; one that can't be resolved
// keeps its provider names.
export async function loadHistoryTeamLabels(context, servedEvents, liveEvents, loadSnapshot, { directoryEntries = null } = {}) {
  const labelsByEvent = {};
  const entries = directoryEntries || await readDirectoryEntries();
  await Promise.all(Object.entries(servedEvents || {}).map(async ([key, item], index) => {
    const live = liveEvents?.[key]?.config;
    const edits = { ...(item.config?.opponents || {}), ...(live?.opponents || {}) };
    const edited = Object.values(edits).some(edit => edit?.name || edit?.coach);
    // With no edits and an empty directory nothing can be renamed, so skip loading the snapshot.
    if (key === context.eventKey || (!edited && !entries.length)) return;
    try {
      const snap = await loadSnapshot(key, item, index);
      if (!snap?.meta?.eventId) return;
      const links = { ...(item.config?.gameChangerTeams || {}), ...(live?.gameChangerTeams || {}) };
      const eventContext = { ...context, eventKey:key, event:{ ...item, config:{ ...(item.config || {}), ...(live || {}) } } };
      const directory = await loadDirectoryMatches(eventContext, snap, links, entries);
      if (!edited && !Object.keys(directory.teams).length) return;
      labelsByEvent[String(snap.meta.eventId)] = editedTeamLabels(await loadTeamDisplay(
        { teamKey:context.teamKey, seasonKey:context.seasonKey, eventKey:key }, snap,
        { opponents:edits, links:directory.links, directoryTeams:directory.teams }));
    } catch {}
  }));
  return labelsByEvent;
}
