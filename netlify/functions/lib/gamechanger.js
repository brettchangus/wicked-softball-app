export const gameChangerNameKey = name => `name:${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export function gameChangerOpponents(structure) {
  const teams = new Map();
  const mine = String(structure?.meta?.providerTeamId || '');
  const add = (id, name) => {
    if (id && String(id) !== mine && name && name !== 'TBD' && !teams.has(String(id)))
      teams.set(String(id), String(name));
  };
  Object.values(structure?.pools || {}).forEach(pool => (pool.teams || []).forEach(t => add(t.id, t.name)));
  (structure?.brackets || []).forEach(bracket => {
    (bracket.teams || []).forEach(t => add(t.id, t.name));
    (bracket.frame || []).forEach(game => { add(game.topId, game.topName); add(game.botId, game.botName); });
  });
  if (structure?.meta?.schedulePending && structure.meta.ast?.teams) {
    const ownName = gameChangerNameKey(structure.meta.ast.teamName);
    structure.meta.ast.teams.forEach(name => {
      const key = gameChangerNameKey(name);
      if (key !== 'name:' && key !== ownName) add(key, name);
    });
  }
  return [...teams].map(([teamId, name]) => ({ teamId, name,
    possibleOpponent:teamId.startsWith('name:') })).sort((a, b) => a.name.localeCompare(b.name));
}

// AST's registered-team list has names but no stable ids until the schedule is published.
// Promote a name-based link only when exactly one published team has that normalized name.
export function resolvedGameChangerLinks(structure, links = {}) {
  const result = { ...links };
  const byName = new Map();
  gameChangerOpponents(structure).filter(t => !t.possibleOpponent).forEach(t => {
    const key = gameChangerNameKey(t.name);
    byName.set(key, [...(byName.get(key) || []), t.teamId]);
  });
  for (const [key, url] of Object.entries(links)) {
    if (!key.startsWith('name:') || !url) continue;
    const ids = byName.get(key) || [];
    if (ids.length === 1 && !Object.hasOwn(result, ids[0])) result[ids[0]] = url;
  }
  return result;
}

// Editorial links live in the season's event config, including for migrated tournaments.
export function gameChangerLinksForContext(_context, saved = {}) {
  return { ...(saved || {}) };
}
