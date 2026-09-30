import { MY_ID, SETUP_VERSION } from './tournament.js';
import { parseTourneyMachineHtml, normalizeTourneyMachineIds, buildTourneyMachineStructureFromParsed } from './tourneymachine.js';
import { divisionAges, divisionMatchesAge, parseAge, findTeamByName } from './divisions.js';
import { geocode, fetchTeamProfile, fetchTeamStats } from './norcal.js';

const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&ndash;|&mdash;/g, '–').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const identity = value => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
// Validates an AST event page URL and returns it parsed, with the path normalized to a trailing
// slash (links are commonly pasted without one — "…/fastpitch/swing-4-the-fences").
function astEventUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('AST event must be an allstartournaments.com/fastpitch/ event URL'); }
  if (url.protocol !== 'https:' || !['allstartournaments.com','www.allstartournaments.com'].includes(url.hostname)
    || url.port || url.username || url.password || !/^\/fastpitch\/[a-z0-9-]+\/?$/.test(url.pathname)) throw new Error('Invalid AST event URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// Ages an AST team-list section covers, from its heading ("10U-Livermore-(…)" → [10],
// "16U/18U" → [16, 18]); falls back to the leading number the section parser captured.
const sectionAges = section => {
  const ages = divisionAges(section.label);
  return ages.length ? ages : [parseAge(section.age)].filter(age => age != null);
};

// The town an age group plays in, from the notes AST appends to its heading: "10U-Livermore-(Teams
// must pre pay…)" → "Livermore", "14U-Pleasanton" → "Pleasanton", "12U-switched location to
// Hayward" → "Hayward". Null when the heading carries no recognizable place ("10U", "16U/18U").
export function astSectionLocality(label) {
  // Notes follow a dash after the age ("10U-…"); a bare "10U Gold" names a bracket, not a town.
  const rest = String(label || '').replace(/^\s*\d{1,2}\s*U(?:\s*\/\s*\d{1,2}\s*U)*/i, '');
  if (!/^\s*[-–—]/.test(rest)) return null;
  const notes = rest.replace(/\([^)]*\)?/g, ' ').split(/\s*[-–—]\s*/).map(part => part.trim()).filter(Boolean);
  const place = /^[A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,2}$/;
  for (const part of notes) {
    if (place.test(part)) return part;
    const moved = part.match(/\bto ([A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,2})$/);
    if (moved) return moved[1];
  }
  return null;
}

export function parseAstRef(value, team = {}) {
  const url = astEventUrl(value);
  const options = new URLSearchParams(url.hash.slice(1));
  const teamName = options.get('team') || team.astTeamName || team.name;
  const region = options.get('region') || team.astRegion;
  if (!region || !teamName) throw new Error('AST requires #region=South%20Bay&team=Exact%20Team%20Name');
  return { key:value, provider:'ast', url:`https://allstartournaments.com${url.pathname}`, region, teamName, agePrefix:String(parseAge(team.agePrefix) ?? 10) };
}

// Event-level fields an AST page carries independent of any one team/region — name, dates, the
// rules PDF, venue map links, and every regional Tourney Machine schedule link (unfiltered; a
// specific ref picks one of these by region — see parseAstPage). Shared by parseAstPage (the
// single-shot build path, which still requires ref.region/ref.teamName) and detectAstEvent (which
// works without them, listing every region as a candidate instead).
export function parseAstMeta(html) {
  const title = clean((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
  const date = title.match(/(\d{1,2})-(\d{1,2})-(20\d{2})/);
  if (!date) throw new Error('AST page is missing its event year/date');
  const start = `${date[3]}-${date[1].padStart(2,'0')}-${date[2].padStart(2,'0')}`;
  const content = clean(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  const range = content.match(/(?:Sept(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\s*[–—&-]\s*(\d{1,2})/i);
  const end = range ? `${date[3]}-${date[1].padStart(2,'0')}-${range[1].padStart(2,'0')}` : start;
  const dates = [];
  for (let day = start; day <= end && dates.length < 14; day = new Date(Date.parse(day) + 86400000).toISOString().slice(0,10)) dates.push(day);
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ url:m[1].replace(/&amp;/g,'&'), label:clean(m[2]) }));
  // Every regional Tourney Machine schedule link on the page, tagged by its own link text (the
  // region name) — unfiltered. parseAstPage narrows this to one region; detectAstEvent lists them
  // all as region candidates.
  const scheduleLinks = links.filter(l => {
    try { const u = new URL(l.url); return u.hostname === 'tourneymachine.com' && u.pathname === '/Public/Results/Tournament.aspx'; } catch { return false; }
  }).map(l => ({ region:l.label, url:l.url }));
  const rulesUrl = links.find(l => /rules.*10/i.test(l.label) && /\.pdf$/i.test(l.url))?.url || null;
  const venues = links.filter(l => /(?:maps\.google\.com|www\.google\.com\/maps)/i.test(l.url));
  return { name:title.slice(0, date.index).trim(), dates, rulesUrl, venues, scheduleLinks };
}

const AST_REGION = /^(Sacramento|South Bay|East Bay|Reno|BLD Manteca)\b/i;

// AST sometimes lists the same team once with a city prefix and again without it.
// Require the same coach suffix before treating those names as aliases.
function astRosterAlias(a, b) {
  if (identity(a) === identity(b)) return true;
  const parts = name => {
    const dash = name.lastIndexOf('-');
    return dash < 0 ? null : {
      team:name.slice(0, dash).trim().toLowerCase().replace(/\s+/g, ' '),
      coach:identity(name.slice(dash + 1)),
    };
  };
  const left = parts(a), right = parts(b);
  return !!(left && right && left.coach && left.coach === right.coach
    && (left.team.endsWith(` ${right.team}`) || right.team.endsWith(` ${left.team}`)));
}

function uniqueAstRoster(teams) {
  const unique = [];
  for (const name of teams) {
    const prior = unique.findIndex(existing => astRosterAlias(existing, name));
    if (prior < 0) unique.push(name);
    else if (name.length > unique[prior].length) unique[prior] = name;
  }
  return unique;
}

// The page's "Locations:" block, in document order: an underlined region name, then one Google
// Maps link per park (`<a href="…maps?q=<street address>">FREE</a> = Freedom Park`). Each park is
// tagged with the region heading that precedes it. Verified live on bat-wars-fall.
export function parseAstVenues(html) {
  const source = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const venues = [];
  let region = '';
  // The text alternative only looks ahead for '<' — consuming it would swallow the start of a map
  // link that directly follows text ("South Bay <a href=…>") and silently drop that park.
  const token = /<a\b[^>]*href=["']([^"']*(?:maps\.google\.com\/maps|www\.google\.com\/maps)[^"']*)["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b|<br\b|<\/p>)|>\s*([^<>]{2,40}?)\s*(?=<)/gi;
  for (const m of source.matchAll(token)) {
    if (m[4] !== undefined) { const heading = clean(m[4]).match(AST_REGION); if (heading && clean(m[4]) === heading[0]) region = heading[1]; continue; }
    let address = '';
    try { address = new URL(m[1].replace(/&amp;/g, '&')).searchParams.get('q') || ''; } catch { continue; }
    if (!address) continue;
    venues.push({ region, code:clean(m[2]), name:clean(m[3]).replace(/^=\s*/, ''), address:address.replace(/\s+/g, ' ').trim() });
  }
  return venues;
}

// Every region/age "TEAMS" section on an AST page, unfiltered (region and age are running state
// across headings — a heading names a region OR an age group, an age heading's teams belong to
// whichever region heading preceded it). parseAstPage narrows this to one region+age; detectAstEvent
// lists distinct regions as candidates and searches every age-matching section for the tracked team.
export function parseAstTeamSections(html) {
  const teamSection = html.slice(html.search(/>\s*TEAMS\s*</i));
  let region = '', age = '';
  const sections = [];
  for (const block of teamSection.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>([\s\S]*?)(?=<h[1-4]\b|$)/gi)) {
    const heading = clean(block[1]);
    // Verified live: a region heading can carry trailing payment/capacity text on the real page
    // ("South Bay-1st (24) teams paid at each park get in") — keep just the canonical region name,
    // not the whole heading, so `region` is clean for display and for a saved manual.region to
    // keep matching a future page where the trailing note has changed or is gone.
    const regionMatch = heading.match(AST_REGION);
    if (regionMatch) { region = regionMatch[1]; age = ''; }
    const group = heading.match(/^(\d+)U\b/i);
    if (group) age = group[1];
    if (!group) continue;
    const teams = [];
    for (const line of block[2].split(/<br\b[^>]*>|<\/p>/i).map(clean)) {
      const name = line.replace(/\s+(?:Pd|conf)(?:\s.*)?$/i,'').replace(/-conf$/i,'').trim();
      if (name && name.length < 100 && !/spots? open|waiting list|gate fee|^\(/i.test(name)) teams.push(name);
    }
    sections.push({ region, age, label:heading, teams:uniqueAstRoster(teams) });
  }
  return sections;
}

export function parseAstPage(html, ref) {
  const meta = parseAstMeta(html);
  const scheduleMatches = meta.scheduleLinks.filter(l => identity(l.region) === identity(ref.region));
  if (scheduleMatches.length > 1 && new Set(scheduleMatches.map(l => l.url)).size > 1) throw new Error('AST has ambiguous regional schedule links');
  // Team lists are grouped by region, then age; payment annotations are not identities.
  const sectionMatches = parseAstTeamSections(html)
    .filter(s => identity(s.region).startsWith(identity(ref.region)) && sectionAges(s).includes(parseAge(ref.agePrefix)));
  const teams = sectionMatches.flatMap(s => s.teams);
  const divisionLabel = sectionMatches.length ? sectionMatches[sectionMatches.length - 1].label : '';
  return { name:meta.name, dates:meta.dates, region:ref.region, divisionLabel, teams,
    // For the coming-soon page: the town this age group plays in, and our exact roster name.
    location:astSectionLocality(divisionLabel), teamName:ref.teamName,
    scheduleUrl:scheduleMatches[0]?.url || null, rulesUrl:meta.rulesUrl, venues:meta.venues };
}

async function read(url) {
  const response = await fetch(url, { signal:AbortSignal.timeout(12000), redirect:'error' });
  if (!response.ok) throw new Error(`AST discovery HTTP ${response.status}`);
  return response.text();
}

// Read-only discovery for the admin "add tournament" flow (docs/tournament-setup-plan.md).
// Unlike parseAstRef/parseAstPage, works without a region or exact team name already known:
// lists every region+age section as a candidate, guesses the region (the team's configured
// default, or the only region on the page) and searches its age-matching section(s) for the
// tracked team by exact name. AST has no stable per-division id the way NorCal/Tourney Machine
// do — the correctable fields are the region and the exact roster team name, not a division
// list — so this returns `region`/`teamName` instead of `divisionIds`/`providerTeamId`. Never
// writes; only an unreachable/invalid page throws.
export async function detectAstEvent(value, team = {}, { readHtml = read, fetchProfileFn = fetchTeamProfile } = {}) {
  const url = astEventUrl(value);
  const pageUrl = `https://allstartournaments.com${url.pathname}`;
  const html = await readHtml(pageUrl);
  const meta = parseAstMeta(html);
  const sections = parseAstTeamSections(html);
  // Regions come from the team lists once posted, but the page names them earlier too — in its
  // regional schedule links and its Locations block — so a region can be picked (and a pending
  // tournament saved) before any team list exists.
  const canonicalRegion = label => clean(label).match(AST_REGION)?.[1] || null;
  const regions = [...new Set([
    ...sections.map(s => s.region),
    ...meta.scheduleLinks.map(l => canonicalRegion(l.region)),
    ...parseAstVenues(html).map(v => v.region),
  ].filter(Boolean))];
  // The team's NorCal profile class ("10-B") is authoritative; the team's Age setting is only a
  // fallback, parsed as a number ("10U"/"10B" would never equal a section's "10").
  const profile = team.norcalTeamId ? await Promise.resolve(fetchProfileFn(team.norcalTeamId)).catch(() => null) : null;
  const age = profile?.age ?? parseAge(team.agePrefix) ?? 10;
  const agePrefix = String(age);
  const teamName = team.astTeamName || team.name || null;
  // Every name our team goes by: the configured AST name, the NorCal profile name (AST rosters use
  // the same "Team-Coach" form), and the display names. See findTeamByName for how they match.
  const teamNames = [teamName, profile?.name, team.name, team.shortName];
  const guessedRegion = team.astRegion || (regions.length === 1 ? regions[0] : null);

  const ageMatches = sections.filter(s => sectionAges(s).includes(age));
  const locations = Object.fromEntries(regions.map(region => [region,
    astSectionLocality(ageMatches.find(s => s.region === region)?.label) || null]));
  const inRegion = list => guessedRegion
    ? list.filter(s => identity(s.region).startsWith(identity(guessedRegion)))
    : list;
  const findTeam = list => findTeamByName(
    list.flatMap(s => s.teams.map(name => ({ region:s.region, name, age:sectionAges(s)[0] ?? null, location:astSectionLocality(s.label) }))),
    teamNames, entry => entry.name);
  // Our age first, in the configured region if any; then other ages (playing up, or a wrong Age
  // setting — take that section's age so the build uses its division); then every region, so an
  // unconfigured region is discovered from where the team is listed.
  const found = findTeam(inRegion(ageMatches)) || findTeam(inRegion(sections))
    || (guessedRegion ? findTeam(ageMatches) || findTeam(sections) : null) || null;
  // Published = a team list exists at our age, or our team was found listed under another age.
  const schedulePublished = ageMatches.length > 0 || !!found;

  const region = found?.region || guessedRegion || null;
  const regionStatus = region ? 'detected' : regions.length ? 'notFound' : schedulePublished ? 'notFound' : 'pending';
  const teamStatus = found ? 'detected' : schedulePublished ? 'notFound' : 'pending';
  const issues = [];
  if (!schedulePublished) issues.push(`AST has not published its team lists for this age group yet.${
    region ? '' : regions.length ? ' Pick the region to save it now.' : ''}`);
  else if (!region) issues.push('Could not determine the region — pick one manually.');
  else if (!found) issues.push(teamName
    ? `Could not find team "${teamName}" in ${region || '(unknown region)'} ${agePrefix}U.`
    : 'No team name configured to search for — pick the team manually.');

  const scheduleUrl = region
    ? meta.scheduleLinks.find(l => identity(l.region) === identity(region))?.url || null
    : null;

  return {
    provider:'ast',
    providerRef:pageUrl,
    schedulePublished,
    detected:{ name:meta.name, dates:meta.dates, rulesUrl:meta.rulesUrl, age:found?.age ?? age, region, teamName:found?.name || null,
      // Location for the review form: the town our team's age group plays in within the region.
      venue: region ? { name:null, city:(found ? found.location : locations[region]) || region } : null },
    candidates:{
      divisions:[],
      // Every listed team, our age first — so picking a region never leaves an empty team list
      // when the team's age is misconfigured or it plays up. A pick from another age carries that
      // age (`age`, `ageMatch:false`) so the build looks in the right Tourney Machine division.
      teams: [...ageMatches, ...sections.filter(s => !ageMatches.includes(s))]
        .flatMap(s => s.teams.map(name => ({ id:name, name, divisionId:s.region,
          age:sectionAges(s).includes(age) ? age : sectionAges(s)[0] ?? null, ageMatch:sectionAges(s).includes(age),
          location:astSectionLocality(s.label) }))),
      regions,
      // Region → the town our age group plays in there (null when AST doesn't say), so picking a
      // region in the editor can fill Location.
      locations,
    },
    fieldStatus:{ region:regionStatus, team:teamStatus },
    issues,
    scheduleUrl,
  };
}

// Setup-time only (never the score refresh), so `geocodeFn` stays within Nominatim's low-volume policy.
export async function buildAstStructure(ref, { canonicalTeamId = MY_ID, readHtml = read, fetchTeamStatsFn = fetchTeamStats, geocodeFn = geocode } = {}) {
  const astHtml = await readHtml(ref.url);
  const page = parseAstPage(astHtml, ref);
  const metadata = { eventId:ref.key, setupVersion:SETUP_VERSION, name:page.name, dates:page.dates,
    bracketDate:page.dates.at(-1), providerTeamId:canonicalTeamId, norcalTeamId:canonicalTeamId,
    sourceUrl:ref.url, ast:page, rulesUrl:page.rulesUrl, generatedAt:new Date().toISOString() };
  if (!page.scheduleUrl) {
    // No schedule yet, so our park is unknown — but the region's parks are listed. Approximate the
    // venue with the region's first park so the weather card has coordinates; the name stays blank
    // (the dashboard shows "Venue to be announced") until the schedule names the actual complex.
    // Prefer the region's park in the town our age group plays in, when AST names one.
    const parks = parseAstVenues(astHtml).filter(v => identity(v.region) && identity(ref.region).startsWith(identity(v.region)));
    const park = (page.location && parks.find(v => identity(v.address).includes(identity(page.location)))) || parks[0];
    const coords = park ? await Promise.resolve(geocodeFn({ address:park.address })).catch(() => null) : null;
    // Season record, NorCal rank, and recent results don't depend on this tournament's schedule —
    // carry them so the dashboard can show them while the schedule is pending.
    const wicked = await Promise.resolve(fetchTeamStatsFn(canonicalTeamId)).catch(() => null);
    return { meta:{ ...metadata, provider:'ast', schedulePending:true, division:`${ref.agePrefix}U`, wicked,
      venue:{ name:'', city:page.location || ref.region, lat:coords?.lat ?? null, lon:coords?.lon ?? null }, myPool:null }, poolOrder:[], pools:{}, brackets:[] };
  }
  const tournamentId = new URL(page.scheduleUrl).searchParams.get('IDTournament');
  if (!tournamentId || !/^[a-zA-Z0-9-]+$/.test(tournamentId)) throw new Error('Invalid Tourney Machine tournament id');
  const html = await readHtml(`https://tourneymachine.com/Public/Results/Tournament.aspx?IDTournament=${tournamentId}`);
  const divisions = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']*Division\.aspx[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = clean(m[2]);
    if (!divisionMatchesAge(label, ref.agePrefix)) continue;
    const url = new URL(m[1].replace(/&amp;/g,'&'), page.scheduleUrl);
    const divisionId = url.searchParams.get('IDDivision');
    if (divisionId && /^[a-zA-Z0-9-]+$/.test(divisionId)) divisions.set(divisionId, label);
  }
  const matches = [];
  for (const [divisionId] of divisions) {
    const tmRef = { key:ref.key, tournamentId, divisionId };
    const parsed = parseTourneyMachineHtml(await readHtml(`https://tourneymachine.com/Public/Results/Division.aspx?IDTournament=${tournamentId}&IDDivision=${divisionId}`), tmRef);
    const teams = new Map(parsed.games.flatMap(g => [[g.topId,g.topName],[g.botId,g.botName]]).filter(([id]) => id));
    const exactIds = [...teams].filter(([,name]) => identity(name.replace(/^\[\d+\]\s*/,'')) === identity(ref.teamName)).map(([id]) => id);
    if (exactIds.length > 1) throw new Error('AST tracked team name is ambiguous');
    // Tourney Machine can format the roster name differently from AST; fall back to
    // the shared matcher, which refuses ambiguous hits.
    const id = exactIds[0] ?? findTeamByName([...teams], [ref.teamName], ([, name]) => name)?.[0];
    if (id) matches.push({ tmRef:{ ...tmRef, providerTeamId:id }, parsed });
  }
  if (matches.length !== 1) throw new Error('Could not uniquely identify the AST tracked team in the published age divisions');
  const { tmRef, parsed } = matches[0];
  const structure = await buildTourneyMachineStructureFromParsed(tmRef,
    normalizeTourneyMachineIds(parsed, tmRef.providerTeamId, canonicalTeamId), { canonicalTeamId, fetchTeamStatsFn, geocodeFn });
  structure.meta = { ...structure.meta, ...metadata, schedulePending:false, provider:'tourneymachine' };
  return structure;
}
