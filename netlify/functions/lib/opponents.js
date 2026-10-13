// Editorial display properties for the teams in one tournament: name, coach, city/state.
// Provider data is never rewritten — an admin's edits are stored as per-team overrides in the
// event config (`config.opponents[teamId]`) and resolved here, so discovery, GameChanger matching
// and schedule diffs keep working from the provider's own names. A blank override field falls
// back to the provider value. Used by the snapshot, the chat context and push text alike.
import { gameChangerNameKey, gameChangerOpponents, resolvedGameChangerLinks } from './gamechanger.js';

const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const compact = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const OPPONENT_FIELDS = ['name', 'coach', 'city', 'state'];

// Provider rosters often append the coach after a dash or in parentheses. Mirrors index.html's
// splitRosterName (the dashboard's fallback when no resolved entry exists) — keep them in sync.
export function splitRosterName(entry) {
  const value = String(entry ?? '');
  const parenthetical = value.match(/^(.*\b\d{1,2}U)\s*\(([A-Za-z][A-Za-z.'’\/ ]*)\)$/i);
  if (parenthetical) return { team:parenthetical[1], coach:parenthetical[2] };
  const m = value.match(/^(.*\S)\s*-\s*([A-Za-z][A-Za-z.'’\/ ]*)$/);
  return m ? { team:m[1], coach:m[2].trim() } : { team:value, coach:'' };
}

export function normalizeState(value) {
  const state = tidy(value);
  return /^california$/i.test(state) ? 'CA' : state;
}

// Validates the editable fields of one override. Returns { fields } holding only the keys that
// were sent ('' = clear the override for that field) or { error }.
export function normalizeOpponentFields(input = {}) {
  const fields = {};
  for (const key of OPPONENT_FIELDS) if (key in input) fields[key] = tidy(input[key]);
  if (fields.state) {
    if (!/^[A-Za-z]{2}$/.test(fields.state)) return { error:'use a two-letter state, like CA' };
    fields.state = fields.state.toUpperCase();
  }
  return { fields };
}

// One team's display properties. Precedence per field: the admin's override, then the provider
// (NorCal profile location, roster-name coach), then the linked GameChanger profile's location.
// The text after the dash in a roster name is not always a coach ("Example Team 10B - Example City"),
// so it is dropped as a coach when it is the team's own city.
export function resolveTeamDisplay(providerName, { override = null, provider = null, gameChanger = null } = {}) {
  const parts = splitRosterName(providerName);
  const saved = Object.fromEntries(OPPONENT_FIELDS.map(key => [key, tidy(override?.[key])]));
  const { city:baseCity, state:baseState } = defaultLocation(provider, gameChanger);
  const city = saved.city || baseCity;
  const state = saved.state || baseState;
  const suffixIsCity = !!parts.coach && !!city && compact(parts.coach) === compact(city);
  const defaults = { name:tidy(parts.team), coach:suffixIsCity ? '' : tidy(parts.coach), city:baseCity, state:baseState };
  const name = saved.name || defaults.name;
  const coach = saved.coach || defaults.coach;
  return {
    providerName:String(providerName ?? ''), name, coach, city, state, defaults,
    override:Object.fromEntries(Object.entries(saved).filter(([, value]) => value)),
    suffixIsCity,
    // The full name the rest of the app prints. Untouched unless the name or coach was edited, so
    // two teams told apart only by their roster suffix never collapse into the same label.
    label:saved.name || saved.coach ? [name, coach].filter(Boolean).join(' - ') : String(providerName ?? ''),
  };
}

// A team's default city/state: the provider's, else the linked GameChanger profile's. Whichever
// source names the city is the place; the other source only fills in a missing state when it
// does not name a different city, so two sources are never mixed into a place neither one gave.
export function defaultLocation(provider, gameChanger) {
  const sources = [provider, gameChanger].map(source => ({ city:tidy(source?.city), state:normalizeState(source?.state) }));
  const place = sources.find(source => source.city);
  if (!place) return { city:'', state:sources.find(source => source.state)?.state || '' };
  const other = sources.find(source => source !== place);
  const sameCity = !other.city || compact(other.city) === compact(place.city);
  return { city:place.city, state:place.state || (sameCity ? other.state : '') };
}

// City/state a provider published for each team (NorCal stamps them at setup).
export function providerTeamLocations(structure) {
  const locations = {};
  const add = team => {
    if (team?.id && (team.city || team.state) && !locations[team.id])
      locations[team.id] = { city:tidy(team.city), state:normalizeState(team.state) };
  };
  Object.values(structure?.pools || {}).forEach(pool => (pool.teams || []).forEach(add));
  (structure?.brackets || []).forEach(bracket => (bracket.teams || []).forEach(add));
  return locations;
}

// Overrides saved against a pending schedule's name-based key follow the team to its published id.
export function opponentOverrides(structure, saved = {}) {
  return resolvedGameChangerLinks(structure, saved || {});
}

// Every team in the tournament (our own included, with no override) → resolved display.
export function teamDisplayMap(structure, savedOverrides = {}, gameChangerLocations = {}) {
  const overrides = opponentOverrides(structure, savedOverrides);
  const provider = providerTeamLocations(structure);
  const teams = gameChangerOpponents(structure).map(t => [t.teamId, t.name]);
  const ownId = String(structure?.meta?.providerTeamId || '');
  const ownName = ownId && [
    ...Object.values(structure?.pools || {}).flatMap(pool => pool.teams || []),
    ...(structure?.brackets || []).flatMap(bracket => bracket.teams || []),
  ].find(team => String(team?.id) === ownId)?.name;
  if (ownName) teams.push([ownId, ownName]);
  return Object.fromEntries(teams.map(([teamId, name]) => [teamId, resolveTeamDisplay(name, {
    override:teamId === ownId ? null : overrides[teamId],
    provider:provider[teamId], gameChanger:gameChangerLocations?.[teamId],
  })]));
}

// The admin Opponents list: every opponent with its resolved, default and overridden values.
export function opponentRows(structure, savedOverrides = {}, gameChangerLocations = {}) {
  const display = teamDisplayMap(structure, savedOverrides, gameChangerLocations);
  return gameChangerOpponents(structure).map(({ teamId, possibleOpponent }) => {
    const { label, suffixIsCity, ...row } = display[teamId];
    return { teamId, possibleOpponent, ...row };
  });
}

// What a GameChanger search should match against: the edited fields first, then the provider's.
// The linked GameChanger profile is left out on purpose — it is what the search is looking for.
export function opponentSearchInput(providerName, { override = null, provider = null } = {}) {
  const display = resolveTeamDisplay(providerName, { override, provider });
  const edited = !!(display.override.name || display.override.coach || display.suffixIsCity);
  return {
    name:edited ? [display.name, display.coach].filter(Boolean).join(' - ') : display.providerName,
    // Explicit parts only when they differ from what the roster name alone would give.
    ...(edited ? { team:display.name, coach:display.coach } : {}),
    city:display.city, state:display.state,
  };
}

// A roster's registered-team names (AST's list, which has names but no ids) as display labels.
// Matched by normalized provider name — a name shared by two teams is left as the provider wrote
// it. For printing only: the names themselves are keys the dashboard derives ids from.
export function registeredTeamLabels(names = [], display = {}) {
  const labels = new Map(), shared = new Set();
  for (const [id, row] of Object.entries(display)) {
    const key = id.startsWith('name:') ? id : gameChangerNameKey(row.providerName);
    if (labels.has(key)) shared.add(key);
    labels.set(key, row.label);
  }
  return names.map(name => {
    const key = gameChangerNameKey(name);
    return (!shared.has(key) && labels.get(key)) || name;
  });
}

// Team id → display label, for just the teams whose name or coach an admin edited.
export function editedTeamLabels(display = {}) {
  return Object.fromEntries(Object.entries(display)
    .filter(([, row]) => row.label && row.label !== row.providerName).map(([id, row]) => [id, row.label]));
}

// The season's game history (`wicked.games`, built from the NorCal team profile and from other
// tournaments' snapshots) names each opponent as its provider did. `labelsByEvent` is
// { eventId: { teamId: label } }: an edit made for one tournament renames that tournament's games only.
export function withRecentResultNames(wicked, labelsByEvent = {}) {
  if (!wicked?.games?.length || !Object.values(labelsByEvent).some(labels => Object.keys(labels).length)) return wicked;
  return { ...wicked, games:wicked.games.map(game => {
    const label = labelsByEvent[String(game.eventId)]?.[String(game.oppId)];
    return label ? { ...game, opp:label } : game;
  }) };
}

// Rewrites team names in a merged snapshot to their display label, by team id. Returns the
// snapshot unchanged when no name or coach was edited.
export function applyTeamDisplay(snap, display = {}) {
  const labels = new Map(Object.entries(editedTeamLabels(display)));
  if (!snap || !labels.size) return snap;
  const named = (row, idKey, nameKey) => (row && labels.has(String(row[idKey])) && row[nameKey] != null
    ? { ...row, [nameKey]:labels.get(String(row[idKey])) } : row);
  const game = g => named(named(named(named(g, 'hid', 'hn'), 'aid', 'an'), 'topId', 'topName'), 'botId', 'botName');
  const standing = row => named(named(row, 'teamID', 'team'), 'id', 'name');
  const pools = Object.fromEntries(Object.entries(snap.pools || {}).map(([key, pool]) => [key, {
    ...pool,
    teams:(pool.teams || []).map(team => named(team, 'id', 'name')),
    games:(pool.games || []).map(game),
    standings:(pool.standings || []).map(standing),
  }]));
  const brackets = (snap.brackets || []).map(bracket => ({
    ...bracket,
    ...(bracket.teams ? { teams:bracket.teams.map(team => named(team, 'id', 'name')) } : {}),
    ...(bracket.frame ? { frame:bracket.frame.map(game) } : {}),
  }));
  const bracketGames = Object.fromEntries(Object.entries(snap.bracketGames || {})
    .map(([level, games]) => [level, (games || []).map(game)]));
  return { ...snap, pools, brackets, bracketGames };
}
