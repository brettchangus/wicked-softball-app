// NorCal discovery + structure assembly. Node- and Netlify-runnable (uses global fetch).
// Given a PUBLIC event id (the number in /pages/event/{id}), auto-discovers the target
// division, its pool rounds (-> poolDisplay schedule ids) and bracket rounds (-> bracket
// ids + format), and assembles the L1 "structure" snapshot the client renders from.
//
// Endpoints (all under api/v1/EP/, no CORS server-side):
//   info-v3.0/desktop/{publicEventId}      -> divisions[].rounds[] (pool|bracket) + facilities + dates
//   poolDisplay/false/{poolRoundKey}/{n}/0 -> one pool's standings + schedule (per poolNo)
//   header4EP/{publicEventId}              -> event display name
// Plus the team endpoint (NOT under EP/): api/v1/Team/{id} -> apex (season record + rank + class).
import { SETUP_VERSION } from './tournament.js';
import { divisionAges, divisionMatchesAge, divisionLevel, parseAge, teamClassAge, teamClassLevel } from './divisions.js';

const API = 'https://norcal.registerplay.com/api/v1/EP';

async function j(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Wicked's season-wide record + CA-NorCal rank, from the team endpoint (api/v1/Team/{id},
// NOT under EP/). `apex` is available year-round and updates after every game — so it
// works pre-event when the current event's pool standings are still empty.
export async function fetchTeamStats(teamId) {
  try {
    const data = await j(`https://norcal.registerplay.com/api/v1/Team/${teamId}`);
    // A team that hasn't played this season has no `apex` block at all (verified live on a new
    // 2027 team) — that's a real 0–0 record with no rank yet, not missing data. Only a response
    // with neither team info nor apex (unknown team) is treated as unavailable.
    if (!data?.apex && !data?.info) return null;
    return teamStatsFrom(data);
  } catch { return null; }
}

// Pure: the season stats a Team/{id} payload describes (exported for tests).
export function teamStatsFrom(data = {}) {
  const a = data.apex || {};
  // Completed game-by-game history (newest first) + per-tournament summary. Used only
  // for the Wicked entry (see buildStructure) to drive the Recent Results card; harmless
  // for other teams since callers read just season/level off the return.
  const games = (data.games || [])
    .filter(g => g.gameStatus === 'completed' && g.score)
    .map(g => ({ date: g.dateTime, opp: g.opponent, oppId: g.opponentID, score: g.score, res: g.isWin ? 'W' : g.isLoss ? 'L' : 'T', eventId: g.eventID, event: g.eventShortName || g.eventName }));
  const tournaments = (data.results || [])
    .filter(r => r.record)
    .map(r => ({ id: r.id, name: r.name, short: r.shortName, record: r.record, place: r.place, pf: r.pf, pa: r.pa, dates: r.dates, class: r.class }));
  // Season W-L-T: prefer counting the completed-games list (current — it reflects each game
  // as soon as it posts), since the apex aggregate (a.win/loss/tie) lags ~a day behind. Fall
  // back to the apex aggregate only when the games list is empty. Tie suffix shown only when >0.
  let sw = 0, sl = 0, st = 0;
  games.forEach(g => { if (g.res === 'W') sw++; else if (g.res === 'L') sl++; else st++; });
  const win = games.length ? sw : (a.win || 0);
  const loss = games.length ? sl : (a.loss || 0);
  const tie = games.length ? st : (a.tie || 0);
  const season = tie ? `${win}-${loss}-${tie}` : `${win}-${loss}`;
  return { season, rank: a.stateRank ?? null, rankOf: a.stateTeamCount ?? null, level: a.teamClass || null, games, tournaments };
}

// Team age/level for discovery, from the SAME endpoint as fetchTeamStats but reading `info`
// instead of `apex` — verified live: `info.teamClass` is "10-B" (parseable via teamClassAge/
// teamClassLevel), while `apex.age` is unreliably null. Available year-round (not tied to any
// one event), so this is the "what age does this team play at" hint used pre-schedule and to
// disambiguate a team whose name appears in more than one division. Returns null on any miss.
export async function fetchTeamProfile(teamId) {
  try {
    const data = await j(`https://norcal.registerplay.com/api/v1/Team/${teamId}`);
    const info = data.info || {};
    if (!info.teamClass) return null;
    return { name: info.name || null, teamClass: info.teamClass,
      age: teamClassAge(info.teamClass), level: teamClassLevel(info.teamClass) };
  } catch { return null; }
}

// Geocode a venue to { lat, lon } via Nominatim (OpenStreetMap) — no API key, but its usage
// policy requires a descriptive User-Agent and low volume, so this is only ever called at
// setup time (buildStructure) or author time (scripts/build-season-venues.mjs), never per
// request. Tries the full street address first, then falls back to "city zip". Returns null
// on any miss/error — never throws — so callers keep their hardcoded coordinate fallback.
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || 'wicked-softball-app (configure GEOCODE_USER_AGENT)';
async function geocodeQuery(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': GEOCODE_UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) return null;
  const hits = await r.json();
  const h = Array.isArray(hits) ? hits[0] : null;
  if (!h || h.lat == null || h.lon == null) return null;
  return { lat: +h.lat, lon: +h.lon };
}
export async function geocode({ address, city, zip } = {}) {
  try {
    const cityZip = [city, zip].filter(Boolean).join(' ').trim();
    if (address) {
      const full = await geocodeQuery([address, cityZip].filter(Boolean).join(', '));
      if (full) return full;
    }
    return cityZip ? await geocodeQuery(cityZip) : null;
  } catch { return null; }
}

// Pick the facility serving this division (falling back to the first one) and return its
// address parts. Shared by buildStructure and fetchEventVenue.
function selectVenue(info, div) {
  const fac = (info.facilities || []).find(f => (f.divisions || []).some(d => d._key === div._key))
           || (info.facilities || [])[0] || {};
  return { name: fac.name || '', address: fac.address || '', city: fac.location || '', zip: fac.zip || '', abr: fac.abr || '' };
}

// Discover + geocode one event's 10U venue, for the season-list fixture (build-season-venues.mjs).
// Returns { name, address, city, zip, lat, lon } — lat/lon null when unpublished or geocode fails.
export async function fetchEventVenue(eventId, { agePrefix = '10' } = {}) {
  const info = await j(`${API}/info-v3.0/desktop/${eventId}`);
  const div = (info.divisions || []).find(v => divisionMatchesAge(v.name, agePrefix));
  if (!div) return null;
  if (!(info.facilities || []).length) {
    const facilities = await j(`${API}/divisionFacilities-v2.0/${div._key}`).catch(() => []);
    if (Array.isArray(facilities)) info.facilities = facilities;
  }
  const v = selectVenue(info, div);
  const coords = v.name ? await geocode(v) : null;
  return { name: v.name, address: v.address, city: v.city, zip: v.zip, lat: coords?.lat ?? null, lon: coords?.lon ?? null };
}

// A division "has a schedule" once either its rounds are already inlined (fixtures, or a v2-style
// payload) or the v3 API flags it lazy-loadable — mirrors the guard in buildStructure.
const hasPublishedSchedule = d => !!d.hasSchedule || !!(d.rounds && d.rounds.length);

// Team ids/names appearing in a division's pool schedule + standings, for team-identity search.
// Loads division-detail-v3.0 only when the division wasn't already given inline rounds (fixtures/
// callers that pre-fetched); never throws — an unreachable division just contributes no teams.
async function divisionParticipants(div, fetchJson) {
  let rounds = div.rounds || [];
  if (div.hasSchedule && !rounds.length) {
    const detail = await fetchJson(`${API}/division-detail-v3.0/${div._key}`).catch(() => null);
    rounds = detail?.rounds || [];
  }
  const teams = new Map();
  const poolRounds = rounds.filter(r => r.type === 'pool');
  for (const r of poolRounds) {
    const count = Array.isArray(r.pools) && r.pools.length ? r.pools.length : 1;
    for (let n = 1; n <= count; n++) {
      const pd = await fetchJson(`${API}/poolDisplay/false/${r._key}/${n}/0`).catch(() => null);
      const p = pd?.pools?.[0];
      if (!p) continue;
      (p.standings || []).forEach(t => { if (t.teamID) teams.set(t.teamID, t.team); });
      (p.schedule || []).forEach(g => {
        if (g.topTeamID) teams.set(g.topTeamID, g.topTeam);
        if (g.botTeamID) teams.set(g.botTeamID, g.botTeam);
      });
    }
  }
  // A bracket-only division (verified live against a real NorCal Championships event: pre-seeded
  // teams straight into the bracket, no pool round at all) has no poolDisplay to read participants
  // from — the bracket frame itself is the only place team identities are published.
  const bracketRounds = rounds.filter(r => r.type === 'bracket');
  for (const r of bracketRounds) {
    const d = await fetchJson(`${API}/Round/bracket/${r._key}/false`).catch(() => null);
    if (!d) continue;
    for (const g of extractBracketFrame(d) || []) {
      if (g.topId) teams.set(g.topId, g.topName);
      if (g.botId) teams.set(g.botId, g.botName);
    }
  }
  return [...teams].map(([id, name]) => ({ id, name }));
}

// NorCal timestamps mark Pacific midnight in UTC ("2026-10-16T07:00:00Z"); read them as Pacific dates.
const pacificDate = iso => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString('en-CA', { timeZone:'America/Los_Angeles' });
};
// Every calendar day from a start to an end timestamp (inclusive), capped at two weeks.
export function norcalDateRange(starts, ends) {
  const start = pacificDate(starts), end = pacificDate(ends);
  const days = [];
  if (!start || !end) return days;
  for (let day = start; day <= end && days.length < 14;
    day = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) days.push(day);
  return days;
}
// Teams registered for the event, from header4EP (teams0/teams1). Published before the schedule —
// the only place team identities exist until NorCal builds pools/brackets. No division is attached.
const registeredTeams = header => [...(header?.teams0 || []), ...(header?.teams1 || [])]
  .filter(t => t?._key).map(t => ({ id:String(t._key), name:String(t.name || '').replace(/\s+/g, ' ').trim() }));

// Read-only discovery for the admin "add tournament" flow (docs/tournament-setup-plan.md Phase 1):
// given a NorCal event id + team, find our division (by norcalTeamId), its same-age sister
// division(s), and the candidate lists an admin needs to correct a miss by hand. Never writes
// anything and never throws for an ordinary "not found yet" — only an unreachable event id throws.
// `fetchJson`/`fetchProfileFn` are injectable for tests.
export async function detectNorcalEvent(eventId, team = {}, { fetchJson = j, fetchProfileFn = fetchTeamProfile } = {}) {
  const info = await fetchJson(`${API}/info-v3.0/desktop/${eventId}`);
  const allDivisions = info.divisions || [];
  // The event's display name lives on a separate endpoint (verified live — info-v3.0 carries no
  // name field at all), same as buildStructure's own name lookup. Best-effort: a failure here
  // just leaves `detected.name` null, same as before this existed.
  const header = await fetchJson(`${API}/header4EP/${eventId}`).catch(() => null);
  const name = (header?.name || header?.eventName || header?.title || '').trim() || null;
  const profile = team.norcalTeamId ? await fetchProfileFn(team.norcalTeamId) : null;
  // A configured team.agePrefix is a legacy/manual fallback; the live team profile wins when present.
  const ageHint = profile?.age ?? parseAge(team.agePrefix);

  const candidateDivisions = allDivisions.map(d => ({
    id: d._key, name: d.name, ages: divisionAges(d.name), level: divisionLevel(d.name),
    hasSchedule: hasPublishedSchedule(d),
  }));
  const schedulePublished = candidateDivisions.some(d => d.hasSchedule);

  // Search cheapest-first (age-matching divisions before the rest) in small batches, so a big
  // event with many age groups doesn't fan out to every division just to find one team — this
  // only runs on an explicit Detect/Save, never in the 5-minute cron.
  const ordered = ageHint != null
    ? [...allDivisions].sort((a, b) =>
        (divisionAges(b.name).includes(ageHint) ? 1 : 0) - (divisionAges(a.name).includes(ageHint) ? 1 : 0))
    : allDivisions;
  const CONCURRENCY = 4;
  const candidateTeams = [];
  let found = null;
  for (let i = 0; i < ordered.length; i += CONCURRENCY) {
    const batch = ordered.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async d => ({
      div: d, teams: hasPublishedSchedule(d) ? await divisionParticipants(d, fetchJson).catch(() => []) : [],
    })));
    for (const { div, teams } of results) {
      teams.forEach(t => candidateTeams.push({ id: t.id, name: t.name, divisionId: div._key }));
      if (!found && team.norcalTeamId) {
        const match = teams.find(t => t.id === team.norcalTeamId);
        if (match) found = { divisionId: div._key, teamId: match.id, teamName: match.name };
      }
    }
  }

  // Before the schedule exists, NorCal still lists registered teams (no division attached). When our
  // team is registered and exactly one division matches our age, that is our division.
  const registered = registeredTeams(header);
  const ageDivisions = ageHint != null ? allDivisions.filter(d => divisionAges(d.name).includes(ageHint)) : [];
  if (!found && team.norcalTeamId && ageDivisions.length === 1) {
    const match = registered.find(t => t.id === String(team.norcalTeamId));
    if (match) found = { divisionId:ageDivisions[0]._key, teamId:match.id, teamName:match.name, inferred:true };
  }
  if (!schedulePublished) {
    // Offer registered teams as pick candidates: a team whose name carries an age goes under the
    // divisions for that age; one without an explicit age under every division.
    for (const t of registered) {
      const ages = divisionAges(t.name);
      for (const d of allDivisions) {
        if ((!ages.length || divisionAges(d.name).some(age => ages.includes(age)))
          && !candidateTeams.some(c => c.id === t.id && c.divisionId === d._key))
          candidateTeams.push({ id:t.id, name:t.name, divisionId:d._key });
      }
    }
  }

  const ourDivision = found ? allDivisions.find(d => d._key === found.divisionId) : null;
  // Age used to find sister divisions: the found division's own age (authoritative) else the hint.
  const detectedAge = ourDivision
    ? divisionAges(ourDivision.name).find(a => a === ageHint) ?? divisionAges(ourDivision.name)[0] ?? null
    : ageHint;
  const sisterDivisionIds = detectedAge != null
    ? allDivisions.filter(d => d._key !== found?.divisionId && divisionAges(d.name).includes(detectedAge)).map(d => d._key)
    : [];

  // Dates/venue preview for the review form — from the SAME info-v3.0 payload already fetched
  // above, no extra request. Venue is best-effort: unlike buildStructure this never falls back to
  // the divisionFacilities-v2.0 endpoint when info.facilities is empty, so a Detect can stay one
  // fetch cheaper than a full build; the full build (on Save) always resolves it properly.
  let dateList = [];
  (info.dates || []).forEach(m => (m.dates || []).forEach(x => dateList.push(String(x.date).slice(0, 10))));
  // Pre-schedule the day list is empty; our division's (else the event's) start/end still give it.
  const dateSource = ourDivision || (ageDivisions.length === 1 ? ageDivisions[0] : null);
  if (!dateList.length) dateList = norcalDateRange(dateSource?.starts || header?.starts || info.eventInfo?.starts,
    dateSource?.ends || header?.ends || info.eventInfo?.ends);
  dateList.sort();
  const venueDiv = ourDivision || ordered[0] || allDivisions[0] || null;
  const venueInfo = venueDiv ? selectVenue(info, venueDiv) : null;
  // Facilities can be unpublished before the schedule, but the event header still carries its city.
  const venue = venueInfo?.name ? { name: venueInfo.name, city: venueInfo.city || header?.location || null }
    : header?.location ? { name: null, city: header.location } : null;

  const divisionsStatus = found ? 'detected' : schedulePublished ? 'notFound' : 'pending';
  const teamStatus = found ? 'detected' : schedulePublished ? 'notFound' : 'pending';
  const issues = [];
  if (!schedulePublished) issues.push(found
    ? `Schedule not yet published — ${found.teamName} is registered, and ${ourDivision.name} is this event's only ${detectedAge}U division.`
    : 'Schedule not yet published — division and team will be detected automatically once it is.');
  else if (!found) issues.push(team.norcalTeamId
    ? `Could not find team ${team.norcalTeamId} in any published division for this event.`
    : 'Team has no norcalTeamId configured — pick its division and team manually.');

  return {
    provider: 'norcal',
    providerRef: String(eventId),
    schedulePublished,
    detected: {
      name,
      dates: dateList,
      venue,
      age: detectedAge,
      divisionIds: found ? [found.divisionId] : [],
      sisterDivisionIds,
      providerTeamId: found?.teamId ?? null,
      teamName: found?.teamName ?? null,
    },
    candidates: { divisions: candidateDivisions, teams: candidateTeams, regions: [] },
    fieldStatus: { divisions: divisionsStatus, team: teamStatus },
    issues,
  };
}

// Map a bracket round's name to display metadata + tier rank (top tier = lowest rank).
const TIERS = { championship: 0, premier: 1, gold: 2, silver: 3, bronze: 4, copper: 5 };
const EMOJI = { championship: '🏆', premier: '🏆', gold: '🥇', silver: '🥈', bronze: '🥉', copper: '🥉' };
const CLS   = { championship: 'brkt-p', premier: 'brkt-p', gold: 'brkt-g', silver: 'brkt-s', bronze: 'brkt-b', copper: 'brkt-b' };
function bracketMeta(name) {
  const n = String(name || '').toLowerCase();
  const level = Object.keys(TIERS).find(k => n.includes(k)) || (n.replace(/[^a-z]/g, '') || 'bracket');
  return {
    level,
    rank: TIERS[level] ?? 99,
    emoji: EMOJI[level] || '🎯',
    cls: CLS[level] || 'brkt-b',
    label: String(name || '').replace(/bracket/i, '').trim() || level,
  };
}
// Bracket size from the template ("SE-5" / "Single Elimination (5 Teams)").
function bracketSize(round) {
  const m = String(round.bracketTemplateShortName || '').match(/(\d+)/)
        || String(round.bracketTemplateDescription || '').match(/(\d+)/);
  return m ? +m[1] : 0;
}

// Discover whether brackets are seeded per skill-division (e.g. Gold = the B teams, Silver = the
// C teams) instead of by one global ranking. NorCal never states the rule, so infer it from the
// data: when there are >=2 skill levels AND the multiset of bracket sizes equals the multiset of
// per-level team counts, each bracket maps to one division. Pair brackets (already tier-ranked,
// best first) with levels in skill order (B<C<D), preferring an exact size match. Otherwise leave
// `division` unset → global-tier seeding (single-level tournaments are unchanged). Mutates `brackets`.
function assignBracketDivisions(brackets, teamList) {
  if (!brackets.length) return;
  const counts = {};
  for (const t of teamList) { if (t.level) counts[t.level] = (counts[t.level] || 0) + 1; }
  const levels = Object.keys(counts);
  if (levels.length < 2) return;                                  // one skill level → global tiers
  const sizes  = brackets.map(b => b.size).slice().sort((a, b) => a - b);
  const counts2 = levels.map(l => counts[l]).slice().sort((a, b) => a - b);
  if (sizes.length !== counts2.length || sizes.some((s, i) => s !== counts2[i])) return; // no clean match
  const remaining = levels.slice().sort();                        // skill order: B before C before D
  for (const b of brackets) {                                     // brackets are pre-sorted by tier rank
    let idx = remaining.findIndex(l => counts[l] === b.size);     // prefer exact size match
    if (idx === -1) idx = 0;                                      // else next in skill order
    b.division = remaining[idx];
    remaining.splice(idx, 1);
  }
}

// Map a NorCal poolDisplay game to the {key,gameNo,time,fac,field,hid/hn/aid/an} shape the
// client uses. top = home (hid), matching the original hand-coded POOLS convention.
function mapGame(g) {
  return {
    key: g._key, gameNo: g.gameNo, time: g.gameTime,
    fac: g.facilityShortName || g.facilityName || '',
    facName: g.facilityName || g.facilityShortName || '',
    field: g.fieldShortName || g.field || '',
    hid: g.topTeamID, hn: g.topTeam, aid: g.botTeamID, an: g.botTeam,
  };
}

// NorCal bracket FRAME — the published structure (seed pairings, byes, rounds, advancement) AND,
// when NorCal has already placed teams into the bracket (e.g. a bracket-only event with no pool
// play to seed from), each slot's ASSIGNED team. Captured so the client renders the AUTHORITATIVE
// bracket shape + matchups instead of recomputing seed order. Each game: `round` = the roundSet
// index (higher = earlier round); a slot is a seed (top/botSeed), an assigned team (top/botId+Name),
// or fed by another game (top/botGame, by |gameNo|; the SIGN encodes winner-of (>0) vs loser-of (<0),
// the latter being the consolation/placement bracket that guarantees every team its extra games).
// Byes are implicit (a bye seed first appears in a later round). Also carries each game's facility +
// field so the client can show the venue like the scoreboard.
//
// NorCal's payload lists each game across several layout slots (some empty), so we MERGE by gameNo,
// taking the first non-null value for each field — that coalesces the seed-only slot with the
// teams+time slot into one complete game record.
function extractBracketFrame(d) {
  const realId = t => (t && t.teamID) ? t.teamID : null; // feed placeholders ("L-36") carry teamID:null
  const byNo = new Map();
  for (const rs of (d.bracket?.roundSets || []))
    for (const round of (rs.rounds || []))
      for (const g of (round.games || [])) {
        if (g.gameNo == null) continue; // skip empty layout slots
        const prev = byNo.get(g.gameNo) || {};
        const tId = realId(g.topTeam), bId = realId(g.botTeam);
        byNo.set(g.gameNo, {
          gameNo: g.gameNo,
          round: prev.round ?? rs.index,
          topSeed: prev.topSeed ?? g.topSeed ?? null, botSeed: prev.botSeed ?? g.botSeed ?? null,
          topGame: prev.topGame ?? g.topGame ?? null, botGame: prev.botGame ?? g.botGame ?? null,
          time: prev.time ?? g.datetime ?? null,
          fac: prev.fac || g.facility?.name || '', facCity: prev.facCity || (g.facility?.city || '').trim(), field: prev.field || g.field || '',
          topId: prev.topId ?? tId, topName: prev.topName ?? (tId ? g.topTeam.label : null),
          botId: prev.botId ?? bId, botName: prev.botName ?? (bId ? g.botTeam.label : null),
        });
      }
  const games = [...byNo.values()];
  return games.length ? games : null;
}

// Seed-ordered team list from a frame's assigned games (index 0 = seed #1; nulls for unassigned
// seeds). Lets the client seed a bracket-only event straight from NorCal's placements.
function seedTeamsFromFrame(frame, size) {
  const out = new Array(size || 0).fill(null);
  for (const g of frame || []) {
    if (g.topSeed && g.topId && g.topSeed <= out.length) out[g.topSeed - 1] = { id: g.topId, name: g.topName, seed: g.topSeed };
    if (g.botSeed && g.botId && g.botSeed <= out.length) out[g.botSeed - 1] = { id: g.botId, name: g.botName, seed: g.botSeed };
  }
  return out.some(Boolean) ? out : null;
}

// Assemble the structure snapshot for an event. `myId` flags the home team / picks MY_POOL;
// `agePrefix` selects the division by name (e.g. "10" -> "10O").
export async function buildStructure(eventId, { myId, agePrefix = '10', divisionIds = null, fetchJson = j, geocodeFn = geocode, fetchTeamStatsFn = fetchTeamStats } = {}) {
  const info = await fetchJson(`${API}/info-v3.0/desktop/${eventId}`);
  // Divisions to use: an explicit selection (an admin's manual correction, or detectNorcalEvent's
  // own pick — see docs/tournament-setup-plan.md) wins outright; otherwise fall back to the age
  // prefix match. Usually one division (a combined "10U" holding the B + C teams), but some events
  // split skill levels into SEPARATE divisions ("10B" + "10C"), each with its own pool + bracket.
  // Collect them ALL — picking only the first would silently drop the sister team's division
  // and its bracket.
  const divs = Array.isArray(divisionIds) && divisionIds.length
    ? divisionIds.map(id => (info.divisions || []).find(v => v._key === id)).filter(Boolean)
    : (info.divisions || []).filter(v => divisionMatchesAge(v.name, agePrefix));
  if (Array.isArray(divisionIds) && divisionIds.length && divs.length !== divisionIds.length)
    throw new Error('a selected division no longer exists in this event — edit the tournament and re-detect');
  if (!divs.length) throw new Error(`no division matching age "${agePrefix}" (saw: ${(info.divisions || []).map(v => v.name).join(', ') || 'none'})`);
  // v3 loads schedules lazily through a separate division-detail endpoint.
  await Promise.all(divs.map(async d => {
    if (d.hasSchedule && !d.rounds?.length) {
      const detail = await fetchJson(`${API}/division-detail-v3.0/${d._key}`);
      if (!Array.isArray(detail.rounds) || !detail.rounds.length) throw new Error('NorCal published schedule has no division rounds');
      d.rounds = detail.rounds;
    }
  }));
  const multiDiv = divs.length > 1;
  // Skill letter from a split division name ("10B" -> "B"); null for a single combined division
  // (whose brackets/teams are tagged by level via assignBracketDivisions instead).
  const divSkill = d => multiDiv ? (((String(d.name).match(/\d+\s*([A-Za-z])\b/) || [])[1] || '').toUpperCase() || null) : null;

  // Pool + bracket rounds across all matched divisions, each tagged with its source division.
  const poolRounds = [];
  const bracketRounds = [];
  for (const d of divs) for (const r of (d.rounds || [])) {
    if (r.type === 'pool') poolRounds.push({ round: r, div: d, skill: divSkill(d) });
    else if (r.type === 'bracket') bracketRounds.push({ round: r, div: d, skill: divSkill(d) });
  }

  // Pools: the info payload's round.pools[] gives the pool count, so fetch every pool
  // (across all rounds) in parallel to stay well under the function timeout. Fall back
  // to a sequential "until empty" probe if a round doesn't list its pool count.
  const reqs = [];
  for (const pr of poolRounds) {
    const r = pr.round;
    const count = Array.isArray(r.pools) && r.pools.length ? r.pools.length : 0;
    if (count) for (let n = 1; n <= count; n++) reqs.push({ pr, n });
    else for (let n = 1; n < 20; n++) { // unknown count → probe sequentially
      let pd; try { pd = await fetchJson(`${API}/poolDisplay/false/${r._key}/${n}/0`); } catch { break; }
      if (!(pd.pools || [])[0]) break;
      reqs.push({ pr, n, pd });
    }
  }
  const fetched = await Promise.all(reqs.map(x => x.pd ? x.pd : fetchJson(`${API}/poolDisplay/false/${x.pr.round._key}/${x.n}/0`).catch(() => null)));
  const rawPools = [];
  reqs.forEach((x, i) => {
    const p = (fetched[i]?.pools || [])[0];
    if (!p) return;
    const games = (p.schedule || []).map(mapGame);
    const names = {};
    games.forEach(g => { if (g.hid) names[g.hid] = g.hn; if (g.aid) names[g.aid] = g.an; });
    (p.standings || []).forEach(t => { if (t.teamID) names[t.teamID] = t.team; });
    rawPools.push({
      roundKey: x.pr.round._key, roundName: x.pr.round.name, div: x.pr.div, skill: x.pr.skill,
      poolNo: p.poolNo || x.n, poolLabel: p.pool || `Pool ${x.n}`,
      teams: Object.entries(names).map(([id, name]) => ({ id, name })),
      games,
    });
  });

  // Assign stable keys + display labels. Split divisions → key/label by skill (Pool B / Pool C).
  // Otherwise: with one pool round use its pool letters (Pool A..D); with several rounds use each
  // round's skill level.
  const multiRound = poolRounds.length > 1;
  const used = new Set();
  const uniq = k => { let x = k, i = 1; while (used.has(x)) x = k + (++i); used.add(x); return x; };
  const pools = {};
  const poolOrder = [];
  const keyDiv = {};  // poolKey -> source division (to pick the primary/venue division)
  rawPools.forEach((p, i) => {
    let key, label;
    if (p.skill) {
      key = uniq(p.skill); label = `Pool ${p.skill}`;
    } else if (multiRound) {
      const lv = (String(p.roundName).match(/\b([A-D])\b/) || [])[1];
      key = uniq(lv || String.fromCharCode(65 + i)); label = `Pool ${lv || key}`;
    } else {
      const lv = (String(p.poolLabel).match(/([A-Z])\s*$/) || [])[1];
      key = uniq(lv || String.fromCharCode(65 + i)); label = p.poolLabel;
    }
    // Split-division pools know their skill (B/C) directly — stamp it onto each team so bracket
    // membership is reliable PRE-EVENT (the team apex `teamClass` is often missing, which would
    // otherwise drop teams from their bracket). Combined-division pools have no skill → left to
    // the apex stamp + assignBracketDivisions below.
    if (p.skill) p.teams.forEach(t => { t.level = p.skill; });
    pools[key] = { label, poolNo: p.poolNo, roundKey: p.roundKey, teams: p.teams, games: p.games };
    poolOrder.push(key);
    keyDiv[key] = p.div;
  });

  poolOrder.sort(); // stable display order (A,B,C,D or B,C)

  // Brackets. Split divisions → one bracket each, tagged with the division's skill level and
  // styled by skill (B = gold, C = silver, D = bronze). Combined division → tier from the bracket
  // name (Gold/Silver/…), with `division` inferred later from team counts.
  const SKILL = { B: { emoji: '🥇', cls: 'brkt-g', rank: 1 }, C: { emoji: '🥈', cls: 'brkt-s', rank: 2 }, D: { emoji: '🥉', cls: 'brkt-b', rank: 3 } };
  const brackets = bracketRounds
    .map(br => {
      const m = bracketMeta(br.round.name);
      const base = { level: m.level, label: m.label, emoji: m.emoji, cls: m.cls, rank: m.rank, id: br.round._key, size: bracketSize(br.round), times: {} };
      if (!br.skill) return base;
      const sk = SKILL[br.skill] || {};
      return {
        ...base,
        level: String(br.div.name).toLowerCase().replace(/[^a-z0-9]/g, '') || base.level,  // "10b"/"10c"
        label: String(br.div.name).trim() || base.label,                                   // "10B"/"10C"
        emoji: sk.emoji || base.emoji, cls: sk.cls || base.cls, rank: sk.rank ?? base.rank,
        division: br.skill,
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank, ...b }) => b); // drop internal rank

  // Capture each bracket's published frame (seed pairings / byes / rounds / assigned teams) so the
  // client draws NorCal's authoritative shape. Also take the bracket's `teamCnt` as the size of
  // record — the template short name (e.g. "3GXIF-18") can't be parsed reliably (bracketSize would
  // grab the leading "3"). For a bracket-only event (teams pre-placed, no pools to seed from),
  // capture the seed-ordered team list too. Non-fatal: a failed fetch just omits these and the
  // client falls back to its generic seed-order renderer.
  await Promise.all(brackets.map(async b => {
    try {
      const d = await fetchJson(`${API}/Round/bracket/${b.id}/false`);
      if (Number.isFinite(d.teamCnt) && d.teamCnt > 0) b.size = d.teamCnt;
      const f = extractBracketFrame(d);
      if (f) { b.frame = f; const ts = seedTeamsFromFrame(f, b.size); if (ts) b.teams = ts; }
    } catch {}
  }));

  const myPool = poolOrder.find(k => pools[k].teams.some(t => t.id === myId)) || poolOrder[0] || null;
  // Primary division (drives venue/meta) = the one Wicked plays in; fall back to the first.
  const primary = (myPool && keyDiv[myPool]) || divs[0];

  // Venue from the facility serving the primary division (geocoded to lat/lon for the weather
  // card); dates from the day list.
  if (!(info.facilities || []).length) {
    const facilities = await fetchJson(`${API}/divisionFacilities-v2.0/${primary._key}`).catch(() => []);
    if (Array.isArray(facilities)) info.facilities = facilities.map(f => ({ ...f, divisions:[{_key:primary._key}] }));
  }
  let name = '', header = null;
  try { header = await fetchJson(`${API}/header4EP/${eventId}`); name = (header.name || header.eventName || header.title || '').trim(); } catch {}
  const fac = selectVenue(info, primary);
  // Pre-schedule NorCal publishes no facilities; fall back to the event header's city so the
  // coming-soon page and weather card still have a location (geocoded at city level).
  if (!fac.name && !fac.city && header?.location) fac.city = header.location;
  const facCoords = fac.name || fac.city ? await geocodeFn(fac) : null;
  const dateList = [];
  (info.dates || []).forEach(m => (m.dates || []).forEach(x => dateList.push(String(x.date).slice(0, 10))));
  if (!dateList.length) dateList.push(...norcalDateRange(primary.starts || header?.starts, primary.ends || header?.ends));
  dateList.sort();

  // Seed each team's season record + level from its Team apex (in parallel), so the
  // standings/bracket season + B/C badges show pre-event before the event's pool standings
  // exist. Include BOTH pool teams and seeded bracket teams: a bracket-only event has no
  // pools, so drawing from pools alone would leave every team (and Wicked's header card)
  // unseeded. Wicked's entry also carries the NorCal rank for the header card.
  const teamList = [...Object.values(pools).flatMap(p => p.teams), ...brackets.flatMap(b => b.teams || [])];
  const ids = [...new Set(teamList.map(t => t.id))];
  const stats = await Promise.all(ids.map(id => fetchTeamStatsFn(id)));
  const statMap = Object.fromEntries(ids.map((id, i) => [id, stats[i]]));
  teamList.forEach(t => { const s = statMap[t.id]; if (s) { if (s.season) t.sr = s.season; if (s.level && !t.level) t.level = s.level; } });
  // Combined division → infer each bracket's division from team levels. Split divisions already
  // carry their division (skip — the counts heuristic could mis-assign across separate divisions).
  if (!multiDiv) assignBracketDivisions(brackets, teamList);
  // Wicked's own stats: prefer the entry already fetched above, but fall back to a direct
  // pull as a safety net if myId somehow isn't in any pool/bracket team list. The Team apex
  // is season-wide, so this works year-round and keeps the header rank/record from going stale.
  const ws = statMap[myId] || await fetchTeamStatsFn(myId);
  const wicked = ws ? { season: ws.season, rank: ws.rank, rankOf: ws.rankOf, games: ws.games || [], tournaments: ws.tournaments || [] } : null;

  return {
    meta: {
      eventId: String(eventId),
      setupVersion: SETUP_VERSION,
      name,
      division: divs.map(d => d.name).join(' / '),
      divisionKey: primary._key,
      divisionIds: divs.map(d => d._key),
      schedulePending: !poolRounds.length && !bracketRounds.length,
      sourceUrl: `https://norcalusasoftball.com/pages/event/${eventId}`,
      dates: dateList,
      bracketDate: dateList[dateList.length - 1] || null,
      venue: { name: fac.name || '', city: fac.city || '', abr: fac.abr || '', address: fac.address || '', ...(facCoords || {}) },
      myPool,
      wicked,
      generatedAt: new Date().toISOString(),
    },
    poolOrder,
    pools,
    brackets,
  };
}
