import { assignedTeamId } from './norcal.js';
import { divisionAges, rosterTeamPart } from './divisions.js';

export const gameChangerNameKey =name => `name:${String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export function gameChangerOpponents(structure) {
  const teams = new Map();
  const mine = String(structure?.meta?.providerTeamId || '');
  // Structures saved before setup dropped NorCal's unassigned-slot id still carry it.
  const add = (id, name) => {
    if (assignedTeamId(id) && String(id) !== mine && name && name !== 'TBD' && !teams.has(String(id)))
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

// AST registration names and published schedule names can differ by age or a missing coach.
// Keep the original name keys as aliases; only promote matches unique in BOTH rosters.
function registeredTeamAliases(structure, teams) {
  const names = [...new Set(structure?.meta?.ast?.teams || [])];
  const normalized = name => gameChangerNameKey(String(name).replace(/\b(?:\d{1,2}\s*U|U\s*\d{1,2})\b/gi, ''));
  const compatibleAge = (a, b) => {
    const left = divisionAges(a), right = divisionAges(b);
    return !left.length || !right.length || (left.length === 1 && right.length === 1 && left[0] === right[0]);
  };
  const candidates = new Map(names.map(name => {
    const eligible = teams.filter(team => compatibleAge(name, team.name));
    const exact = eligible.filter(team => normalized(name) === normalized(team.name));
    const core = normalized(rosterTeamPart(name));
    const matches = exact.length ? exact : eligible.filter(team => {
      if (core !== normalized(rosterTeamPart(team.name))) return false;
      // Two explicit, different coaches are different teams, even if each roster has only one.
      return normalized(name) === core || normalized(team.name) === core;
    });
    return [name, matches];
  }));
  const aliases = new Map();
  for (const [name, matches] of candidates) {
    if (matches.length !== 1) continue;
    const id = matches[0].teamId;
    if ([...candidates.values()].filter(rows => rows.some(team => team.teamId === id)).length === 1)
      aliases.set(gameChangerNameKey(name), id);
  }
  return aliases;
}

export function resolvedGameChangerLinks(structure, links = {}) {
  const result = { ...links };
  const teams = gameChangerOpponents(structure).filter(t => !t.possibleOpponent);
  const byName = new Map();
  teams.forEach(t => {
    const key = gameChangerNameKey(t.name);
    byName.set(key, [...(byName.get(key) || []), t.teamId]);
  });
  const aliases = registeredTeamAliases(structure, teams);
  for (const [key, url] of Object.entries(links)) {
    if (!key.startsWith('name:') || !url) continue;
    const ids = byName.get(key) || (aliases.has(key) ? [aliases.get(key)] : []);
    if (ids.length === 1 && !Object.hasOwn(result, ids[0])) result[ids[0]] = url;
  }
  return result;
}

// Editorial links live in the season's event config, including for migrated tournaments.
export function gameChangerLinksForContext(_context, saved = {}) {
  return { ...(saved || {}) };
}
