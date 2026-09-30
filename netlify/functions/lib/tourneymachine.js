import { SETUP_VERSION, MY_ID } from './tournament.js';
import { fetchTeamStats, fetchTeamProfile, geocode } from './norcal.js';
import { divisionAges, divisionLevel, parseAge, findTeamByName } from './divisions.js';

const BASE = 'https://tourneymachine.com/Public/Results/Division.aspx';
const decode = s => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const text = s => decode(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (s, name) => decode((String(s).match(new RegExp(`${name}=["']([^"']*)["']`, 'i')) || [])[1] || '');
const isoDate = ymd => `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`;

function localTime(date, time) {
  const m = String(time).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return `${date}T00:00:00`;
  let h = Number(m[1]); if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12; if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return `${date}T${String(h).padStart(2,'0')}:${m[2]}:00`;
}

// The division page's "Complexes" panel: a Google Maps marker per complex (inline JS assigns
// `complexN.ID/name/lat/long`) plus a list item holding its street address. TM geocodes these
// itself, so setup gets venue coordinates without a lookup of our own. Missing/zero coords → null.
export function parseTourneyMachineComplexes(html) {
  const source = String(html || '');
  const complexes = new Map();
  for (const m of source.matchAll(/\b(complex\d+)\.(ID|name|lat|long)\s*=\s*'((?:[^'\\]|\\.)*)'/g)) {
    if (!complexes.has(m[1])) complexes.set(m[1], {});
    complexes.get(m[1])[m[2]] = m[3].replace(/\\(.)/g, '$1');
  }
  const coord = v => { const n = Number(v); return v && Number.isFinite(n) && n !== 0 ? n : null; };
  return [...complexes.values()].filter(c => c.name).map(c => {
    const item = c.ID ? source.split(`data-id="${c.ID}"`)[1] || '' : '';
    const lines = ((item.match(/<address>([\s\S]*?)<\/address>/i) || [])[1] || '')
      .split(/<br\s*\/?>/i).map(text).filter(Boolean);
    return { id:c.ID || null, name:text(c.name), lat:coord(c.lat), lon:coord(c.long),
      address:lines.join(', '), city:(lines.at(-1) || '').replace(/\s+\d{5}(?:-\d{4})?$/, '') };
  });
}

// Our venue: the complex whose name matches the facility our games are at (TM's schedule column
// is "Complex - Field"), else the only complex listed. Coordinates come from TM's own map markers;
// `geocodeFn` fills them from the street address only when TM has no marker position. Setup passes
// it; the 5-minute score refresh doesn't, so the cron never hits Nominatim.
export async function resolveTourneyMachineVenue(venueName, complexes = [], geocodeFn = null) {
  const key = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const complex = complexes.find(c => key(c.name) === key(venueName))
    || (complexes.length === 1 ? complexes[0] : null);
  const venue = { name:venueName || complex?.name || '', city:complex?.city || '', address:complex?.address || '',
    lat:complex?.lat ?? null, lon:complex?.lon ?? null };
  if ((venue.lat == null || venue.lon == null) && geocodeFn && venue.address) {
    const coords = await Promise.resolve(geocodeFn({ address:venue.address })).catch(() => null);
    if (coords?.lat != null && coords?.lon != null) { venue.lat = coords.lat; venue.lon = coords.lon; }
  }
  return venue;
}

export function parseTourneyMachineHtml(html, ref) {
  const rows = [];
  const rowRe = /<tr\b([^>]*class=["'][^"']*\bschedule_row\b[^"']*["'][^>]*)>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html))) {
    const cells = [...rm[2].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(m => ({ attrs:m[1], html:m[2], value:text(m[2]) }));
    if (cells.length < 7) continue;
    const gameNo = cells[0].value;
    const dateMatch = attr(rm[1], 'class').match(/\bdate_(\d{8})\b/);
    if (!gameNo || !dateMatch) continue;
    const rawGameId = attr(rm[1], 'data-gameid');
    const date = isoDate(dateMatch[1]);
    const venue = cells[2].value;
    const dash = venue.lastIndexOf(' - ');
    const score1 = cells[4].value, score2 = cells[5].value;
    const explicitScores = /^\d+$/.test(score1) && /^\d+$/.test(score2);
    rows.push({
      key: `tm:${ref.tournamentId}:${ref.divisionId}:${gameNo}`,
      sourceGameId: rawGameId, gameNo, date, time: localTime(date, cells[1].value),
      fac: dash >= 0 ? venue.slice(0, dash) : venue, facName: dash >= 0 ? venue.slice(0, dash) : venue,
      field: dash >= 0 ? venue.slice(dash + 3) : '',
      topId: attr(cells[3].attrs, 'data-teamid') || null, topName: cells[3].value,
      botId: attr(cells[6].attrs, 'data-teamid') || null, botName: cells[6].value,
      topScore: explicitScores ? Number(score1) : null, botScore: explicitScores ? Number(score2) : null,
      status: explicitScores ? 'completed' : 'upcoming',
    });
  }
  const seen = new Set();
  for (const g of rows) { if (seen.has(g.gameNo)) throw new Error(`duplicate Tourney Machine game number ${g.gameNo}`); seen.add(g.gameNo); }
  if (!rows.length) throw new Error('Tourney Machine page contained no schedule games');

  const standings = [];
  let pool = 'A';
  for (const table of html.matchAll(/<table\b[^>]*tournamentResultsTable[^>]*>([\s\S]*?)<\/table>/gi)) {
    const label = text(table[1]).match(/^Pool\s+([A-Z0-9]+)$/i);
    if (label) { pool = label[1].toUpperCase(); continue; }
    if (!/<th[^>]*>\s*Team\s*<\/th>/i.test(table[1])) continue;
    for (const m of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...m[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map(x => ({ html:x[2], value:text(x[2]) }));
      if (cells.length < 4) continue;
      const link = cells[0].html.match(/IDTeam=([^&"']+)/i);
      const nums = cells.slice(1,4).map(c => Number(c.value));
      if (!link || nums.some(n => !Number.isFinite(n))) continue;
      standings.push({ pool, teamID:decode(link[1]), team:cells[0].value, win:nums[0], loss:nums[1], tie:nums[2], record:`${nums[0]}-${nums[1]}-${nums[2]}` });
    }
  }
  const name = text((html.match(/<a[^>]*id=["'][^"']*Tournament_HyperLink["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1]);
  const division = text((html.match(/<h1[^>]*class=["']visible-print["'][^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  return { games: rows, standings, name, division, complexes: parseTourneyMachineComplexes(html) };
}

export async function fetchTourneyMachine(ref) {
  const url = `${BASE}?IDTournament=${encodeURIComponent(ref.tournamentId)}&IDDivision=${encodeURIComponent(ref.divisionId)}`;
  const res = await fetch(url, { headers:{ 'User-Agent':'WickedSoftballApp/1.0 schedule reader' }, signal:AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Tourney Machine HTTP ${res.status}`);
  return parseTourneyMachineHtml(await res.text(), ref);
}

async function defaultReadHtml(url) {
  const res = await fetch(url, { headers:{ 'User-Agent':'WickedSoftballApp/1.0 schedule reader' }, signal:AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Tourney Machine HTTP ${res.status}`);
  return res.text();
}
const identity = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');

// A tournament-level page's own division list (no IDDivision — every division in the
// tournament), for the admin "add tournament" flow's ambiguous-URL case. Real IDDivision links
// only, deduped, in page order.
export function listTourneyMachineDivisions(tournamentHtml, baseUrl = BASE) {
  const seen = new Set();
  const divisions = [];
  for (const m of tournamentHtml.matchAll(/<a\b[^>]*href=["']([^"']*Division\.aspx[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = text(m[2]);
    let url;
    try { url = new URL(m[1].replace(/&amp;/g,'&'), baseUrl); } catch { continue; }
    const divisionId = url.searchParams.get('IDDivision');
    if (!divisionId || !/^[a-zA-Z0-9-]+$/.test(divisionId) || seen.has(divisionId)) continue;
    seen.add(divisionId);
    divisions.push({ id:divisionId, label });
  }
  return divisions;
}

// Interprets a bare tournament URL/id, a division-specific URL, or a tm: ref into its parts —
// tournamentId is required for the rest to work; divisionId/providerTeamId may be absent.
function parseTourneyMachineRef(value) {
  const v = String(value || '').trim();
  const tm = v.match(/^tm:([^:]+):([^:]+)(?::([^:]+))?$/);
  if (tm) return { tournamentId:tm[1], divisionId:tm[2], providerTeamId:tm[3] || null };
  const tmBare = v.match(/^tm:([^:]+)$/); // "tm:<tournament-id>" shorthand — no division chosen yet
  if (tmBare) return { tournamentId:tmBare[1], divisionId:null, providerTeamId:null };
  try {
    const url = new URL(v);
    if (!/(^|\.)tourneymachine\.com$/i.test(url.hostname)) return {};
    return {
      tournamentId: url.searchParams.get('IDTournament'),
      divisionId: url.searchParams.get('IDDivision') || null,
      providerTeamId: null,
    };
  } catch { return {}; }
}

// Read-only discovery for the admin "add tournament" flow (docs/tournament-setup-plan.md), for a
// Tourney Machine tournament reached directly — not through AST, see ast.js's own detect for
// that. Accepts a bare tournament URL/id (ambiguous across divisions — every division becomes a
// candidate), a division-specific URL, or a tm:<tournament>:<division>[:<team>] ref. Never
// writes; an unreachable tournament page throws, an ordinary "team not found yet" does not.
export async function detectTourneyMachineEvent(value, team = {}, { readHtml = defaultReadHtml, fetchProfileFn = fetchTeamProfile } = {}) {
  const parsed = parseTourneyMachineRef(value);
  if (!parsed.tournamentId) throw new Error('Tourney Machine event must be a tournament/division URL or tm:<tournament-id>:<division-id>[:<provider-team-id>]');
  const html = await readHtml(`https://tourneymachine.com/Public/Results/Tournament.aspx?IDTournament=${parsed.tournamentId}`);
  const allDivisions = listTourneyMachineDivisions(html);
  const teamName = team.tourneyMachineTeamName || team.astTeamName || team.name || null;
  // Names our team goes by — including the NorCal profile name, which
  // tournament rosters commonly reuse. The profile class also gives the age hint.
  const profile = team.norcalTeamId ? await Promise.resolve(fetchProfileFn(team.norcalTeamId)).catch(() => null) : null;
  const teamNames = [team.tourneyMachineTeamName, team.astTeamName, profile?.name, team.name, team.shortName];
  const ageHint = profile?.age ?? parseAge(team.agePrefix);
  const candidateDivisions = allDivisions.map(d => ({
    id:d.id, name:d.label, ages:divisionAges(d.label), level:divisionLevel(d.label), hasSchedule:true,
  }));
  const schedulePublished = allDivisions.length > 0;

  // Search cheapest-first: an explicit division from the input, then age-matching divisions,
  // before the rest — bounded concurrency, same pattern as detectNorcalEvent.
  const rest = allDivisions.filter(d => d.id !== parsed.divisionId);
  const ordered = ageHint != null
    ? [...rest].sort((a, b) => (divisionAges(b.label).includes(ageHint) ? 1 : 0) - (divisionAges(a.label).includes(ageHint) ? 1 : 0))
    : rest;
  const explicit = parsed.divisionId ? allDivisions.find(d => d.id === parsed.divisionId) : null;
  const searchOrder = explicit ? [explicit, ...ordered] : ordered;
  const CONCURRENCY = 4;
  const candidateTeams = [];
  let found = null;
  let tournamentName = null; // same across every division of one tournament — first one wins
  const gamesByDivision = new Map(); // divisionId -> parsed games, for the dates/venue preview below
  const complexesByDivision = new Map(); // divisionId -> Complexes panel (venue coordinates)
  for (let i = 0; i < searchOrder.length; i += CONCURRENCY) {
    const batch = searchOrder.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async d => {
      let teams = [], name = null, games = [], complexes = [];
      try {
        const p = parseTourneyMachineHtml(
          await readHtml(`https://tourneymachine.com/Public/Results/Division.aspx?IDTournament=${parsed.tournamentId}&IDDivision=${d.id}`),
          { tournamentId:parsed.tournamentId, divisionId:d.id });
        name = p.name || null;
        games = p.games || [];
        complexes = p.complexes || [];
        const map = new Map();
        games.forEach(g => { if (g.topId) map.set(g.topId, g.topName); if (g.botId) map.set(g.botId, g.botName); });
        teams = [...map].map(([id, name]) => ({ id, name }));
      } catch { /* division not reachable yet — contributes no candidates, never throws */ }
      return { div:d, teams, name, games, complexes };
    }));
    for (const { div, teams, name, games, complexes } of results) {
      if (!tournamentName && name) tournamentName = name;
      gamesByDivision.set(div.id, games);
      complexesByDivision.set(div.id, complexes);
      teams.forEach(t => candidateTeams.push({ id:t.id, name:t.name, divisionId:div.id }));
      if (!found) {
        const byHint = parsed.divisionId === div.id && parsed.providerTeamId
          ? teams.find(t => t.id === parsed.providerTeamId) : null;
        const byName = findTeamByName(teams, teamNames, t => t.name);
        const match = byHint || byName;
        if (match) found = { divisionId:div.id, teamId:match.id, teamName:match.name };
      }
    }
  }

  const detectedDivisionId = found?.divisionId ?? parsed.divisionId ?? null;
  const divisionsStatus = detectedDivisionId ? 'detected' : schedulePublished ? 'notFound' : 'pending';
  const teamStatus = found ? 'detected' : schedulePublished ? 'notFound' : 'pending';
  const issues = [];
  if (!schedulePublished) issues.push('This tournament has no divisions published yet.');
  else if (!found) issues.push(teamName
    ? `Could not find team "${teamName}" in any division of this tournament.`
    : 'No team name configured to search for — pick the division and team manually.');

  // Dates/venue preview for the review form, read off our own division's actual games (not just
  // any division — a combined tournament can run different age groups on different days/fields).
  const detectedGames = detectedDivisionId ? (gamesByDivision.get(detectedDivisionId) || []) : [];
  const dateList = [...new Set(detectedGames.map(g => g.date).filter(Boolean))].sort();
  const venueName = detectedGames.find(g => g.fac)?.fac || null;
  // Coordinates come off the same already-fetched division page's map markers — no geocoding here,
  // so Detect stays one pass of page reads. Unknown city stays null (the form falls back to the name).
  const venue = venueName
    ? await resolveTourneyMachineVenue(venueName, complexesByDivision.get(detectedDivisionId) || [])
    : null;

  return {
    provider:'tourneymachine',
    providerRef: detectedDivisionId ? `tm:${parsed.tournamentId}:${detectedDivisionId}${found?.teamId ? ':' + found.teamId : ''}` : null,
    tournamentId: parsed.tournamentId,
    schedulePublished,
    detected: {
      name: tournamentName,
      dates: dateList,
      venue: venue ? { name: venue.name, city: venue.city || null, lat: venue.lat, lon: venue.lon } : null,
      age: detectedDivisionId ? (divisionAges(allDivisions.find(d => d.id === detectedDivisionId)?.label)[0] ?? null) : null,
      divisionIds: detectedDivisionId ? [detectedDivisionId] : [],
      sisterDivisionIds: [],
      providerTeamId: found?.teamId ?? null,
      teamName: found?.teamName ?? null,
    },
    candidates: { divisions:candidateDivisions, teams:candidateTeams, regions:[] },
    fieldStatus: { divisions:divisionsStatus, team:teamStatus },
    issues,
  };
}

// Keep one canonical Wicked id throughout the snapshot/client while retaining the provider id
// only at the fetch boundary. Games and standings must be normalized together or the standings
// join (`teamID === team.id`) silently drops Wicked.
export function normalizeTourneyMachineIds(parsed, sourceTeamId, canonicalTeamId = MY_ID) {
  parsed.games.forEach(g => {
    g.topSourceId = g.topId; g.botSourceId = g.botId;
    if (g.topId === sourceTeamId) g.topId = canonicalTeamId;
    if (g.botId === sourceTeamId) g.botId = canonicalTeamId;
  });
  parsed.standings.forEach(s => { if (s.teamID === sourceTeamId) s.teamID = canonicalTeamId; });
  return parsed;
}

export async function buildTourneyMachineStructure(ref, { canonicalTeamId = MY_ID } = {}) {
  const parsed = normalizeTourneyMachineIds(
    await fetchTourneyMachine(ref), ref.providerTeamId, canonicalTeamId);
  return buildTourneyMachineStructureFromParsed(ref, parsed, { canonicalTeamId, geocodeFn:geocode });
}

// Named finals a placement bracket can end in, best-first. A bracket with N finals gets its finals
// (in game order) labelled with the first N of these; single-final brackets carry no tier at all.
const TIER_KEYS = ['gold', 'silver', 'bronze'];

// Derive the bracket's shape from the parsed "B#" games rather than hardcoding a layout: each game's
// placement seeds (Pool/Bracket A N Place) and winner/loser feeds (Bracket Winner/Loser B#) come straight off the
// labels, `round` is the longest feed-chain from a game down to a final (finals are round 1, so a
// feeder always outranks the game it advances to — the renderer draws earliest rounds first), and a
// "final" is any game whose WINNER isn't consumed by a later game. Returns { frame, finals }
// (finals = final game numbers, ascending). One final → a single connected bracket; several finals
// (e.g. separate Gold + Silver championships) → a placement bracket the client splits into one tree
// per final. This adapts automatically when the tournament restructures (e.g. 6-team Gold/Silver →
// 5-team single-champion) instead of mislabelling the games.
export function buildBracketFrame(bracketGames) {
  const num = g => Number(String(g.gameNo).replace(/\D/g, ''));
  const seedOf = name => { const m = String(name || '').match(/(?:Pool|Bracket)\s+([A-Z0-9]+)\s+(\d+).*Place/i); return m ? { pool:m[1].toUpperCase(), seed:Number(m[2]) } : {}; };
  const frame = bracketGames.map(g => ({
    gameNo: num(g), key: g.key, sourceGameId:g.sourceGameId, round: 0, time: g.time, fac: g.fac, field: g.field,
    topId: g.topId, topName: g.topName, botId: g.botId, botName: g.botName,
    topSeed: seedOf(g.topName).seed ?? null, botSeed: seedOf(g.botName).seed ?? null,
    topPool: seedOf(g.topName).pool || null, botPool: seedOf(g.botName).pool || null,
    topGame: feed(g.topName), botGame: feed(g.botName),
  }));
  // Forward edges (game → the games its winner/loser advance to) + the winners some later game
  // consumes; a game whose winner is never consumed is a final (a bracket championship).
  const feedsInto = new Map(frame.map(g => [g.gameNo, []]));
  const consumedWinner = new Set();
  for (const g of frame) for (const ref of [g.topGame, g.botGame]) {
    if (ref == null) continue;
    const src = Math.abs(ref);
    if (feedsInto.has(src)) feedsInto.get(src).push(g.gameNo);
    if (ref > 0) consumedWinner.add(src);
  }
  const finals = frame.filter(g => !consumedWinner.has(g.gameNo)).map(g => g.gameNo).sort((a, b) => a - b);
  const memo = new Map();
  const roundOf = no => {
    if (memo.has(no)) return memo.get(no);
    memo.set(no, 1); // guard against a malformed cycle (brackets are DAGs)
    const outs = feedsInto.get(no) || [];
    const r = outs.length ? 1 + Math.max(...outs.map(roundOf)) : 1;
    memo.set(no, r); return r;
  };
  frame.forEach(g => { g.round = roundOf(g.gameNo); });
  // Assigned names can replace either a pool seed or a feeder. Missing links therefore
  // cannot establish finals unless every slot's origin is still known.
  const topologyKnown = frame.length > 0 && (frame.length === 1 || frame.every(g =>
    ['top','bot'].every(side => g[side + 'Seed'] != null || g[side + 'Game'] != null)));
  return { frame, finals:topologyKnown ? finals : [], topologyKnown };
}

export async function buildTourneyMachineStructureFromParsed(ref, parsed, {
  fetchTeamStatsFn = fetchTeamStats, canonicalTeamId = MY_ID, geocodeFn = null,
} = {}) {
  const poolGames = parsed.games.filter(g => /^P/i.test(g.gameNo));
  const bracketGames = parsed.games.filter(g => /^B/i.test(g.gameNo));
  const names = new Map();
  poolGames.forEach(g => { if(g.topId) names.set(g.topId,g.topName); if(g.botId) names.set(g.botId,g.botName); });
  if (!names.has(canonicalTeamId)) throw new Error('tracked team is missing from the Tourney Machine division');
  const dates = [...new Set(parsed.games.map(g => g.date))].sort();
  const { frame, finals, topologyKnown } = buildBracketFrame(bracketGames);
  // Bracket entrants = the highest pool seed the frame references (top-N of the pool); fall back to
  // the full pool when a frame is all feeds and carries no seeds.
  const maxSeed = Math.max(0, ...frame.flatMap(g => [g.topSeed, g.botSeed]).filter(n => n != null));
  const size = new Set(parsed.standings.map(s => s.pool || 'A')).size > 1 ? names.size : maxSeed || names.size;
  const bracket = { level:'championship', label: finals.length > 1 ? 'Gold / Silver' : 'Championship', emoji:'🏆', cls:'brkt-g', size, frame, topologyKnown, placementGames:{} };
  // Emit placementGames keyed by the finals so the client draws the connected-tree layout: several
  // finals → one named tree each (Gold/Silver); a single final → one 'championship' tree rooted at it.
  // Downstream single-vs-multi checks key off `> 1` finals, so a single-entry map still reads as one
  // bracket for seeding/medals — it only selects the graphical renderer over the plain column one.
  if (topologyKnown && finals.length) bracket.placementGames = Object.fromEntries(finals.map((no, i) =>
    [finals.length > 1 ? (TIER_KEYS[i] || `tier${i + 1}`) : 'championship', `B${no}`]));
  const pools = {};
  const membership = new Map(parsed.standings.map(s => [s.teamID, s.pool || 'A']));
  const keys = [...new Set(parsed.standings.map(s => s.pool || 'A'))];
  if (!keys.length) keys.push('A');
  for (const [i, key] of keys.entries()) {
    pools[key] = { label:`Pool ${key}`, poolNo:i + 1, roundKey:`tm:${ref.divisionId}:pool:${key}`,
      authoritativeStandings:keys.length === 1, teams:[], games:[] };
  }
  for (const [id, name] of names) {
    const key = membership.get(id) || (keys.length === 1 ? keys[0] : null);
    if (!key) throw new Error(`Tourney Machine pool membership missing for ${name}`);
    pools[key].teams.push({ id, name });
  }
  for (const g of poolGames) {
    const key = membership.get(g.topId) || keys[0];
    pools[key].games.push({ key:g.key, sourceGameId:g.sourceGameId, gameNo:g.gameNo,time:g.time,fac:g.fac,facName:g.facName,field:g.field,hid:g.topId,hn:g.topName,aid:g.botId,an:g.botName });
  }
  // Multi-pool seed numbers are local, not global ranks. Keep the official labels until
  // assigned teams arrive instead of projecting an opponent from the wrong pool.
  if (keys.length > 1) for (const g of frame) { g.topSeed = null; g.botSeed = null; }
  const myPool = keys.find(k => pools[k].teams.some(t => t.id === canonicalTeamId)) || null;
  const venueName = poolGames.find(g => g.topId === canonicalTeamId || g.botId === canonicalTeamId)?.fac || parsed.games[0]?.fac || '';
  const venue = await resolveTourneyMachineVenue(venueName, parsed.complexes, geocodeFn);
  const wicked = await fetchTeamStatsFn(canonicalTeamId).catch(() => null);
  return {
    meta:{ eventId:ref.key, provider:'tourneymachine', setupVersion:SETUP_VERSION, name:parsed.name || 'Tournament', division:parsed.division || '', dates, bracketDate:dates.at(-1),
      venue, projectionUnsupported:keys.length > 1, myPool, providerTeamId:canonicalTeamId, sourceProviderTeamId:ref.providerTeamId, norcalTeamId:canonicalTeamId,
      tourneyMachineRef:ref,
      sourceUrl:`${BASE}?IDTournament=${ref.tournamentId}&IDDivision=${ref.divisionId}`, wicked, generatedAt:new Date().toISOString() },
    poolOrder:keys, pools, brackets:frame.length ? [bracket] : [],
  };
}

function feed(name) {
  const m = String(name).match(/^Bracket (Winner|Loser) B(\d+)$/i);
  return m ? (m[1].toLowerCase() === 'winner' ? 1 : -1) * Number(m[2]) : null;
}

// Refresh schedule data while retaining published feed edges that disappear when TM replaces
// placeholders with team names. Never transfer saved results to a reused game number.
export function reconcileTourneyMachineStructure(previous, next) {
  const keys = value => new Set([
    ...Object.values(value.pools || {}).flatMap(p => p.games || []),
    ...(value.brackets || []).flatMap(b => b.frame || []),
  ].map(g => g.key));
  const nextKeys = keys(next);
  if ([...keys(previous)].some(key => !nextKeys.has(key)))
    throw new Error('Tourney Machine removed games; re-run setup to review removals');
  const oldGames = new Map(Object.values(previous.pools || {}).flatMap(p => p.games || []).map(g => [g.key, g]));
  for (const g of Object.values(next.pools || {}).flatMap(p => p.games || [])) {
    const old = oldGames.get(g.key);
    if (old && ((old.sourceGameId && g.sourceGameId && old.sourceGameId !== g.sourceGameId)
      || old.hid !== g.hid || old.aid !== g.aid)) throw new Error('Tourney Machine changed game identity; re-run setup to review');
  }
  const oldFrame = new Map((previous.brackets || []).flatMap(b => b.frame || []).map(g => [g.key,g]));
  for (const g of (next.brackets || []).flatMap(b => b.frame || [])) {
    const old = oldFrame.get(g.key);
    if (old?.sourceGameId && g.sourceGameId && old.sourceGameId !== g.sourceGameId)
      throw new Error('Tourney Machine changed bracket game identity; re-run setup to review');
  }
  preserveTourneyMachineTopology(previous, next);
  next.meta = { ...previous.meta, ...next.meta, name:previous.meta.name || next.meta.name,
    // Keep the stored venue while it's the same complex — unless it has no coordinates and the
    // fresh pull does (a structure built before complex parsing, or TM added the marker later).
    venue:previous.meta.venue?.name === next.meta.venue?.name
      && (previous.meta.venue?.lat != null || next.meta.venue?.lat == null) ? previous.meta.venue : next.meta.venue, generatedAt:previous.meta.generatedAt };
  return next;
}

export function changedTourneyMachineIdentities(previous, next) {
  const poolGames = s => Object.values(s?.pools || {}).flatMap(p => p.games || []);
  const bracketGames = s => (s?.brackets || []).flatMap(b => b.frame || []);
  const previousPool = new Map(poolGames(previous).map(g => [g.key,g]));
  const previousBracket = new Map(bracketGames(previous).map(g => [g.key,g]));
  const sourceChanged = (a,b) => a?.sourceGameId && b.sourceGameId && a.sourceGameId !== b.sourceGameId;
  return [
    ...poolGames(next).filter(g => {
      const old = previousPool.get(g.key);
      return old && (sourceChanged(old,g) || old.hid !== g.hid || old.aid !== g.aid);
    }),
    ...bracketGames(next).filter(g => sourceChanged(previousBracket.get(g.key),g)),
  ].map(g => g.key);
}

// Used by score polling AND full discovery. Only restore a verified graph when all
// provider game identities match and no remaining published origin contradicts it.
export function preserveTourneyMachineTopology(previous, next) {
  if (!previous || previous.meta?.eventId !== next.meta?.eventId
    || previous.meta?.sourceProviderTeamId !== next.meta?.sourceProviderTeamId) return next;
  for (const b of next.brackets || []) {
    if (b.topologyKnown) continue;
    const old = previous.brackets?.find(x => x.level === b.level);
    if (!old?.topologyKnown || old.frame?.length !== b.frame?.length) continue;
    const byKey = new Map(old.frame.map(g => [g.key,g]));
    const compatible = b.frame.every(g => {
      const prior = byKey.get(g.key);
      if (!prior || !g.sourceGameId || g.sourceGameId !== prior.sourceGameId) return false;
      return ['top','bot'].every(side => ['Game','Seed','Pool'].every(field =>
        g[side + field] == null || g[side + field] === prior[side + field]));
    });
    if (!compatible) continue;
    for (const g of b.frame) {
      const prior = byKey.get(g.key);
      for (const field of ['topGame','botGame','topSeed','botSeed','topPool','botPool','round']) g[field] = prior[field];
    }
    b.topologyKnown = true;
    b.placementGames = { ...old.placementGames };
    b.label = old.label;
    b.size = old.size;
  }
  return next;
}
