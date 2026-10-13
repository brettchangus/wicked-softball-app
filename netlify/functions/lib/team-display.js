// The one place a tournament's team display map is assembled from stored data, so the snapshot,
// the chat context and push text all resolve names, coaches and locations from the same inputs
// (see lib/opponents.js for the rules). Kept apart from opponents.js, which stays pure.
import { readGameChangerRecords } from './snapshot.js';
import { gameChangerLinksForContext, resolvedGameChangerLinks } from './gamechanger.js';
import { locationsForGameChangerLinks } from './gamechanger-records.js';
import { teamDisplayMap } from './opponents.js';

// `opponents` / `links` are the event config's overrides and GameChanger links; `ownUrl` is our
// own team's profile link. Pass `profiles` when the saved GameChanger profiles are already loaded.
export async function loadTeamDisplay(scope, structure, { opponents = {}, links = {}, ownUrl = '', profiles = null } = {}) {
  const resolved = resolvedGameChangerLinks(structure, gameChangerLinksForContext(null, links));
  const ownId = structure?.meta?.providerTeamId;
  if (ownId && ownUrl) resolved[ownId] = ownUrl;
  const saved = profiles || (scope ? await readGameChangerRecords(scope) : {});
  return teamDisplayMap(structure, opponents, locationsForGameChangerLinks(resolved, saved));
}
