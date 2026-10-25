// Fictional demo data for the README screenshots and video (scripts/readme-media/capture.mjs).
//
// Every identity, venue and player is fictional. Self-contained tournament templates live in
// demo-templates.mjs; no private snapshots, Blob storage or provider access are needed.
//
// The served snapshot goes through the real `mergeSnapshot` / `withSeedingRules`, and scouting
// reports are presented with the real metrics, summary and star-rating code, so the page sees the
// same shapes production serves.
import { mergeSnapshot } from '../../netlify/functions/lib/snapshot.js';
import { withSeedingRules } from '../../netlify/functions/lib/seeding.js';
import { scoutingMetrics, SCOUTING_METHOD_VERSION } from '../../netlify/functions/lib/scouting-metrics.ts';
import { teamSummary } from '../../netlify/functions/lib/scouting-summary.ts';
import { starRating } from '../../netlify/functions/lib/scouting-rating.ts';

import { LIVE_TEMPLATE, HISTORY_TEMPLATE } from './demo-templates.mjs';

export const TEAM_KEY = 'riverton-ravens-10b';
export const SEASON_KEY = 'fall-2026';
export const EVENT_KEY = 'harvest-moon-classic';
export const CONTEXT_PATH = `/teams/${TEAM_KEY}/seasons/${SEASON_KEY}`;
const EVENT_ID = '7300000001';
const HISTORY_EVENT_ID = '7300000103';
const HISTORY_EVENT_KEY = 'autumn-slam';

// Deterministic pseudo-random numbers, so every run produces the same demo.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashSeed = text => [...String(text)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

const OUR_NAME = 'Ravens 10B';
const COACHES = ['Alvarez', 'Bennett', 'Castillo', 'Delgado', 'Ellison', 'Fong', 'Garner', 'Hollis', 'Ibarra', 'Jensen',
  'Kowalski', 'Lindqvist', 'Moreno', 'Nakamura', 'Okafor', 'Prescott', 'Quintero', 'Ramsey', 'Sato', 'Torres'];

export const OUR_ID = '7100000001';
export const SISTER_ID = '7100000002';

const VENUE = { name:'Lakeside Sports Park', city:'Riverton, CA', abr:'LSP', address:'100 Lakeside Drive', lat:38.5449, lon:-121.7405 };

// Pool standings rows recomputed from the games that are final at `now` (Saturday scenario).
function standingsFrom(event, isFinal) {
  const out = {};
  for (const [poolKey, pool] of Object.entries(event.pools)) {
    const rows = new Map(pool.standings.map(r => [r.teamID, { ...r, w:0, l:0, PF:0, PA:0 }]));
    for (const g of pool.games) {
      const r = event.results[g.key];
      if (!r || !isFinal(g)) continue;
      const home = rows.get(g.hid), away = rows.get(g.aid);
      if (!home || !away) continue;
      home.PF += r.topScore; home.PA += r.botScore; away.PF += r.botScore; away.PA += r.topScore;
      if (r.topScore > r.botScore) { home.w++; away.l++; } else if (r.botScore > r.topScore) { away.w++; home.l++; }
    }
    out[poolKey] = [...rows.values()]
      .sort((a, b) => b.w - a.w || a.l - b.l || a.PA - b.PA || b.PF - a.PF)
      .map((r, i) => ({ place:i + 1, teamID:r.teamID, team:r.team, logo:null, teamRanking:r.teamRanking,
        overallRecord:r.overallRecord, class:r.class, record:`${r.w}-${r.l}`, PF:r.PF, PA:r.PA, PD:r.PF - r.PA }));
  }
  return out;
}

const pacific = iso => Date.parse(iso + (iso.length === 19 ? '-08:00' : ''));
const GAME_MINUTES = 95;
// Final, live (with a proportional partial score) or upcoming, judged at `now`.
function statusAt(time, final, now) {
  const elapsed = (now - pacific(time)) / 60000;
  if (elapsed >= GAME_MINUTES) return { ...final };
  if (elapsed < 0) return null;
  const share = Math.max(.15, elapsed / GAME_MINUTES);
  return { topScore:Math.round(final.topScore * share), botScore:Math.round(final.botScore * share), status:'inprogress' };
}

// Our season so far: recent results (newest first) and the header record/rank.
function seasonBlock(extraGames = []) {
  const games = [
    ...extraGames,
    { date:'2026-10-25T13:40:00', opp:'Summit Storm 10B', score:'4-6', res:'L', event:'Autumn Slam' },
    { date:'2026-10-25T11:15:00', opp:'Pinecrest Panthers', score:'9-2', res:'W', event:'Autumn Slam' },
    { date:'2026-10-24T15:30:00', opp:'Harbor Hawks 10U', score:'11-3', res:'W', event:'Autumn Slam' },
    { date:'2026-10-24T12:00:00', opp:'Orchard Owls', score:'8-1', res:'W', event:'Autumn Slam' },
    { date:'2026-10-24T09:00:00', opp:'Seaside Sharks 10U', score:'7-5', res:'W', event:'Autumn Slam' },
    { date:'2026-10-11T14:00:00', opp:'Granite Grizzlies 10B', score:'3-5', res:'L', event:'Pumpkin Patch Classic' },
    { date:'2026-10-11T10:30:00', opp:'Lakeview Lightning', score:'10-4', res:'W', event:'Pumpkin Patch Classic' },
    { date:'2026-10-10T16:00:00', opp:'Delta Dragons 10U', score:'12-0', res:'W', event:'Pumpkin Patch Classic' },
  ].map(g => ({ ...g, oppId:null, eventId:g.event === 'Autumn Slam' ? HISTORY_EVENT_ID : '7300000102' }));
  return { season:'24-4-1', rank:1, rankOf:87, level:'B', games };
}

const SEEDING_RULES = { primary:'winPercentage', allowsTies:false, tiebreakers:['headToHead', 'runsAllowed', 'runDifferential'] };

const SEASON_ROWS = [
  { name:'Fall Kickoff Classic', dates:'Sep 19–20', startDate:'2026-09-19', endDate:'2026-09-20', location:'Riverton, CA', finish:'1st', providerRef:'7300000101' },
  { name:'Pumpkin Patch Classic', dates:'Oct 10–11', startDate:'2026-10-10', endDate:'2026-10-11', location:'Maple Grove, CA', finish:'3rd', providerRef:'7300000102' },
  { name:'Autumn Slam', dates:'Oct 23–25', startDate:'2026-10-23', endDate:'2026-10-25', location:'Cedar Falls, CA', finish:'2nd', providerRef:HISTORY_EVENT_ID, key:HISTORY_EVENT_KEY },
  { name:'Harvest Moon Classic', dates:'Nov 6–8', startDate:'2026-11-06', endDate:'2026-11-08', location:'Riverton, CA', providerRef:EVENT_ID, key:EVENT_KEY },
  { name:'Turkey Bowl Invitational', dates:'Nov 21–22', startDate:'2026-11-21', endDate:'2026-11-22', location:'Fairview, CA', providerRef:'7300000105' },
  { name:'Winter Warmup', dates:'Dec 5–6', startDate:'2026-12-05', endDate:'2026-12-06', location:'Riverton, CA', providerRef:'7300000106' },
];

export const ROSTER = [
  ['Ava', 2, 'light', 'blond'], ['Maya', 4, 'tan', 'black', true], ['Sofia', 7, 'brown', 'black'], ['Lily', 9, 'light', 'red'],
  ['Zoe', 11, 'tan', 'brown'], ['Emma', 13, 'light', 'brown', false, true], ['Nora', 15, 'brown', 'black'],
  ['Chloe', 17, 'light', 'blond'], ['Isla', 21, 'tan', 'brown', true], ['Ruby', 23, 'light', 'red'], ['Mia', 27, 'brown', 'black'],
].map(([name, number, tone, hair, batsL = false, fieldsL = false]) => ({ name, number, tone, hair, batsL, fieldsL }));

const HIGH_SCORES = [['Maya', 'MAYA', 14], ['Sofia', 'SOFIA', 12], ['Coach Sam', 'ZOE', 11], ['Ava', 'AVA', 10], ['Lily', 'LILY', 9],
  ['Dad', 'NORA', 8], ['Isla', 'ISLA', 7], ['Grandma', 'RUBY', 6], ['Chloe', 'CHLOE', 5], ['Emma', 'EMMA', 4]]
  .map(([name, batter, homeRuns], i) => ({ id:'demo-' + i, name, batter, homeRuns, date:'11/1/2026' }));
export const highScores = () => ({ board:HIGH_SCORES });

const CATALOG = {
  defaultTeamKey:TEAM_KEY,
  teams:{ [TEAM_KEY]:{ key:TEAM_KEY, name:OUR_NAME, defaultSeasonKey:SEASON_KEY,
    seasons:{ [SEASON_KEY]:{ key:SEASON_KEY, name:'Fall 2026', status:'active' } } } },
};
export const catalog = () => CATALOG;

// What snapshot.js adds on top of the merged layers: config, context, catalog, season list.
function decorate(snap, teamDisplay, scoutingReports) {
  const served = withSeedingRules(snap, { config:{ seedingRules:SEEDING_RULES } });
  return {
    ...served,
    rev:'demo',
    config:{
      snacksUrl:'https://example.com/snacks', rulesUrl:'https://example.com/rules',
      customLink:{ title:'Team photos', url:'https://example.com/photos' },
      teamKey:TEAM_KEY, teamName:OUR_NAME, teamShortName:OUR_NAME, seasonKey:SEASON_KEY, seasonName:'Fall 2026',
      eventKey:EVENT_KEY, seasonOver:false, vapidPublicKey:'', streamLinks:{},
      gameChangerTeams:{}, gameChangerTeamNames:{}, gameChangerRecords:{}, gameChangerLocations:{}, teamDisplay,
    },
    seasonData:SEASON_ROWS.map(row => ({ ...row, venue:{ lat:VENUE.lat, lon:VENUE.lon } })),
    seasonFinishes:Object.fromEntries(SEASON_ROWS.filter(r => r.finish).map(r => [r.providerRef, r.finish])),
    archiveEvents:{ [HISTORY_EVENT_ID]:{ eventKey:HISTORY_EVENT_KEY, name:'Autumn Slam', snapshotPath:null, archived:false } },
    context:{
      team:{ key:TEAM_KEY, name:OUR_NAME, shortName:OUR_NAME, subtitle:'Riverton, CA · Coach: Sam Rivera',
        logoUrl:'/assets/icon.png', norcalTeamId:OUR_ID, sisterTeamId:SISTER_ID },
      season:{ key:SEASON_KEY, name:'Fall 2026', status:'active', archiveVersion:null },
      event:{ key:EVENT_KEY, name:'Harvest Moon Classic', providerRef:EVENT_ID },
    },
    catalog:CATALOG,
    miniGame:{ roster:ROSTER },
    scoutingReports,
  };
}

// Each opponent's coach and hometown, shown wherever the dashboard names a team.
function teamDisplayFor(event) {
  const towns = ['Riverton', 'Maple Grove', 'Cedar Falls', 'Fairview', 'Lakeport', 'Bay Harbor', 'Pine Ridge', 'Oakdale', 'Sunnyside', 'Clearwater'];
  const display = {};
  for (const team of Object.values(event.pools).flatMap(p => p.teams)) {
    const r = rng(hashSeed(team.id));
    display[team.id] = {
      name:team.name, providerName:team.name,
      coach:team.id === OUR_ID || team.id === SISTER_ID ? 'Sam Rivera' : COACHES[Math.floor(r() * COACHES.length)],
      city:team.id === OUR_ID || team.id === SISTER_ID ? 'Riverton' : towns[Math.floor(r() * towns.length)], state:'CA',
    };
  }
  return display;
}

// ---- the live tournament ------------------------------------------------------------------------
const liveTemplate = () => structuredClone(LIVE_TEMPLATE);

// Moments the capture freezes the page clock at (Pacific).
export const SCENARIO_TIMES = {
  saturday:'2026-11-07T15:35:00-08:00',   // pool play: our game is live, the next one later today
  sunday:'2026-11-08T18:20:00-08:00',     // championship day: our Premier final is live
};

function structureLayer(event, { assigned }) {
  const brackets = event.brackets.map(b => assigned ? b : {
    ...b, teams:null,
    frame:b.frame.map(f => ({ ...f, topId:null, topName:null, botId:null, botName:null })),
  });
  return { meta:event.meta, poolOrder:event.poolOrder, pools:event.pools, brackets };
}

function scenarioSnapshot(name, reports) {
  const event = liveTemplate();
  const now = Date.parse(SCENARIO_TIMES[name]);
  const games = {};
  const allPoolGames = Object.values(event.pools).flatMap(p => p.games);
  for (const g of allPoolGames) {
    const final = event.results[g.key];
    const r = final && statusAt(g.time, final, now);
    if (r) games[g.key] = r;
  }
  const finalAt = g => games[g.key]?.status === 'completed';
  let bracketGames = {};
  if (name === 'sunday') {
    bracketGames = Object.fromEntries(Object.entries(event.bracketGames).map(([level, list]) => [level, list.map(g => {
      // Our Premier final is the live game: a close one, in the 5th.
      if (level === 'premier' && (g.topId === OUR_ID || g.botId === OUR_ID) && g.gameNo === 5)
        return { ...g, topScore:g.topId === OUR_ID ? 6 : 4, botScore:g.topId === OUR_ID ? 4 : 6, status:'inprogress' };
      return g;
    })]));
  }
  const layer2 = {
    games, standings:standingsFrom({ ...event, results:event.results }, finalAt), bracketGames,
    updatedAt:new Date(now - 2 * 60000).toISOString(), wicked:seasonBlock(),
  };
  const snap = mergeSnapshot(structureLayer(event, { assigned:name === 'sunday' }), layer2, {});
  return decorate(snap, teamDisplayFor(event), reports.map(r => r.summary));
}

// ---- the completed past tournament (Autumn Slam), opened from the season list --------------------
function historySnapshot() {
  const event = structuredClone(HISTORY_TEMPLATE);
  event.meta.venue = { name:'Cedar Falls Community Park', city:'Cedar Falls, CA', abr:'CFCP', address:'2200 Falls Road', lat:38.67, lon:-121.15 };
  const final = () => true;
  const snap = mergeSnapshot(structureLayer(event, { assigned:true }), {
    games:event.results, standings:standingsFrom(event, final), bracketGames:event.bracketGames,
    updatedAt:'2026-10-26T03:10:00.000Z', wicked:seasonBlock(),
  }, {});
  return decorate(snap, teamDisplayFor(event), []);
}

// ---- scouting reports ---------------------------------------------------------------------------
const FIRST = ['Addison', 'Brooklyn', 'Camila', 'Delaney', 'Eliana', 'Fiona', 'Gianna', 'Harper', 'Ivy', 'Jade', 'Kinsley', 'Layla',
  'Madison', 'Naomi', 'Olivia', 'Peyton', 'Quinn', 'Reese', 'Savannah', 'Tessa', 'Valeria', 'Willa', 'Ximena', 'Yara', 'Zara'];
const LAST = ['Aguilar', 'Brooks', 'Carver', 'Dunn', 'Estrada', 'Fischer', 'Greer', 'Hayes', 'Iverson', 'Jacobs', 'Keane', 'Lowe',
  'Mendez', 'Nolan', 'Ortega', 'Pierce', 'Reyes', 'Shaw', 'Tran', 'Underwood', 'Vance', 'Whitaker', 'Young', 'Zamora'];
const SCOUT_OPPONENTS = ['Cedar Falls Comets', 'Maple Grove Mayhem', 'Lakeport Lasers', 'Bay Harbor Blaze', 'Pine Ridge Pirates',
  'Oakdale Aces', 'Sunnyside Smash', 'Clearwater Crush 10C', 'Fairview Fury', 'Riverbend Rebels 10C', 'Summit Storm 10B', 'Harbor Hawks 10U'];
const pick = (r, list) => list[Math.floor(r() * list.length)];
const poisson = (r, mean) => { let k = 0, p = 1; const l = Math.exp(-mean); do { k++; p *= r(); } while (p > l); return k - 1; };
const SCOUT_DAYS = ['2026-09-12', '2026-09-13', '2026-09-19', '2026-09-20', '2026-09-26', '2026-10-03', '2026-10-04',
  '2026-10-10', '2026-10-11', '2026-10-17', '2026-10-24', '2026-10-25'];

// Splits `total` runs over `count` innings, with the occasional crooked number.
function inningLine(r, total, count) {
  const line = Array(count).fill(0);
  for (let i = 0; i < total; i++) line[Math.min(count - 1, Math.floor(Math.pow(r(), 1.35) * count))]++;
  return line;
}

function scoutingReport(team, strength, firstPitch, asOf) {
  const r = rng(hashSeed('scout:' + team.id));
  // Unique first names, last names and jersey numbers within a roster.
  const shuffled = list => list.map(v => [r(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const [firsts, lasts, numbers] = [shuffled(FIRST), shuffled(LAST), shuffled(Array.from({ length:40 }, (_, i) => String(i + 1)))];
  const roster = Array.from({ length:11 }, (_, i) => ({
    id:'p' + (i + 1), name:firsts[i] + ' ' + lasts[i], number:numbers[i],
    contact:.17 + r() * .13 + strength * .04 + (i < 3 ? .08 : 0), power:r() * (i < 4 ? .35 : .15), eye:.07 + r() * .1,
  }));
  const pitchers = roster.slice(0, 3).map((p, i) => ({ ...p, kSkill:.14 + r() * .12 + (i === 0 ? .07 : 0) + strength * .03, control:.07 + r() * .1 }));
  const games = SCOUT_DAYS.map((day, gi) => {
    const opponent = pick(r, SCOUT_OPPONENTS);
    const isC = /10C/.test(opponent) || r() < .25;
    const innings = r() < .7 ? 6 : 5;
    let rf = Math.max(0, poisson(r, 5.2 + strength * 2.6 + (isC ? 1.6 : 0)));
    const ra = Math.max(0, poisson(r, 5.4 - strength * 2 - (isC ? 1.8 : 0)));
    if (rf === ra && r() < .8) rf++;           // ties happen, but rarely
    const hitters = roster.slice(0, 9 + Math.floor(r() * 3)).map(p => {
      const pa = 2 + Math.floor(r() * 2.4);
      let ab = 0, h = 0, bb = 0, so = 0, d = 0, t = 0, hr = 0;
      for (let i = 0; i < pa; i++) {
        const x = r();
        if (x < p.eye) { bb++; continue; }
        ab++;
        if (x < p.eye + p.contact) { h++; const y = r(); if (y < p.power * .12) hr++; else if (y < p.power * .3) t++; else if (y < p.power) d++; }
        else if (r() < .32) so++;
      }
      return { id:p.id, name:p.name, number:p.number, positions:[], stats:{ AB:ab, H:h, '2B':d, '3B':t, HR:hr, BB:bb, SO:so, HBP:0, SF:0, R:0, RBI:0, SB:0, CS:0 } };
    });
    // Runs, RBIs and steals go to the hitters who reached base.
    const onBase = hitters.flatMap(h => Array(h.stats.H + h.stats.BB).fill(h));
    for (let i = 0; i < rf && onBase.length; i++) { pick(r, onBase).stats.R++; pick(r, hitters.filter(h => h.stats.H) .length ? hitters.filter(h => h.stats.H) : hitters).stats.RBI++; }
    for (const h of onBase) if (r() < .3) { if (r() < .82) h.stats.SB++; else h.stats.CS++; }
    let outsLeft = innings * 3, runsLeft = ra;
    const used = pitchers.slice(0, gi % 3 === 2 ? 3 : 2);
    const pitched = used.map((p, i) => {
      const outs = i === used.length - 1 ? outsLeft : Math.min(outsLeft - 3, 6 + Math.floor(r() * 7));
      outsLeft -= outs;
      const er = i === used.length - 1 ? runsLeft : Math.min(runsLeft, Math.floor(ra * outs / (innings * 3)));
      runsLeft -= er;
      const so = Math.round(outs * (p.kSkill + r() * .12)), bb = Math.round(outs * p.control * (.7 + r() * .6));
      const hits = Math.max(0, Math.round(er * .9 + r() * 2));
      return { id:p.id, name:p.name, number:p.number, positions:['P'], stats:{ OUTS:outs, BF:outs + hits + bb, H:hits, BB:bb, SO:so, ER:er, R:er } };
    });
    return {
      id:'g' + (gi + 1), date:`${day}T${String(9 + (gi % 4) * 2).padStart(2, '0')}:00:00-07:00`, opponent, opponentId:null, opponentPublicId:null,
      rf, ra, source:'#', kind:'competitive', innings:inningLine(r, rf, innings), hitters, pitchers:pitched, warnings:[], boxScore:true,
      level:{ group:isC ? 'C' : 'B', basis:'NorCal classification', source:null, games:0, largeLosses:0, share:null },
    };
  });
  const level = /10C/.test(team.name) ? 'C' : 'B';
  const rating = { level, rank:Math.max(2, Math.round(30 - strength * 24)), rankOf:87, source:'NorCal' };
  const views = Object.fromEntries(['B', 'C', 'All'].map(group => [group, scoutingMetrics(games, group, asOf)]));
  const finishes = strength > .55 ? [{ event:'Pumpkin Patch Classic', place:1, bracket:'Gold', top:true }] : [];
  const generatedAt = '2026-11-06T20:15:00.000Z';
  const report = {
    opponent:{ id:team.id, name:team.name, role:'opponent', gameKeys:[], firstPitch },
    generatedAt, refreshedAt:'2026-11-07T21:40:00.000Z', asOf, methodVersion:SCOUTING_METHOD_VERSION, sourceUrl:null,
    sourceFingerprint:'demo', levelRevision:null, rating,
    collection:{ publicId:'demo', name:team.name, season:'2026-fall', games, warnings:[], collectedAt:generatedAt },
    history:{ scope:'season', meetings:strength > .4 ? [{ date:'2026-10-25T13:40:00-07:00', event:'Autumn Slam', res:'L', score:'4-6' }] : [],
      warnings:['Meetings come from this season’s tournament results.'] },
    warnings:[], views, summary:teamSummary(views.All.games, rating), stars:starRating(views.All.games, level, finishes),
    norcal:{ url:null, level:'10' + level },
  };
  const summary = { methodVersion:SCOUTING_METHOD_VERSION, id:team.id, name:team.name, generatedAt, refreshedAt:report.refreshedAt,
    asOf, sourceUrl:null, levelRevision:null };
  return { report, summary };
}

// Strength from the template's season record, so the bracket favorites scout as the better teams.
function strengthOf(row) {
  const [w, l] = String(row?.overallRecord || '10-10').split('-').map(Number);
  return Math.max(-.8, Math.min(.9, (w / Math.max(1, w + l) - .5) * 2.2));
}

function buildReports() {
  const event = liveTemplate();
  const rows = new Map(Object.values(event.pools).flatMap(p => p.standings).map(r => [r.teamID, r]));
  const ourGames = Object.values(event.pools).flatMap(p => p.games).filter(g => g.hid === OUR_ID || g.aid === OUR_ID);
  const bracketOpp = Object.values(event.bracketGames).flat().filter(g => g.topId === OUR_ID || g.botId === OUR_ID);
  const firstPitchFor = id => {
    const g = ourGames.find(x => x.hid === id || x.aid === id) || bracketOpp.find(x => x.topId === id || x.botId === id);
    return g ? g.time + '-08:00' : null;
  };
  return Object.values(event.pools).flatMap(p => p.teams)
    .filter(t => t.id !== OUR_ID && t.id !== SISTER_ID)
    .map(t => scoutingReport(t, strengthOf(rows.get(t.id)), firstPitchFor(t.id), '2026-11-06T08:00:00.000Z'));
}

// ---- chat ---------------------------------------------------------------------------------------
const CHAT_ANSWERS = [
  [/play next|next game/i, {
    saturday:'We’re playing Harbor Hawks 10U right now on Field 1 at Lakeside Sports Park — up 3–0 in the 2nd. Our last pool game is tonight at 6:30 PM vs Bayside Breakers, also on Field 1. Win both and we finish pool play 3–0.',
    sunday:'We’re in the Premier championship right now — 6–4 Ravens over Meadowbrook Monarchs in the 5th on Field 1. A win means 1st place in the Premier bracket! 🏆',
  }],
  [/tiebreak/i, { any:'Pool play ties are broken by: 1) head-to-head (two-team ties only), 2) fewest runs allowed, 3) run differential. Records are compared by winning percentage, and pool games can end in a tie when the time limit expires.' }],
  [/bracket|beat|win/i, {
    saturday:'If we finish 1st in Pool A, we’re projected as the #1 seed in the Premier bracket with a first-round bye. Our first bracket game would be Sunday at 1:45 PM against the winner of the #4 vs #5 game.',
    sunday:'If we win this game we take 1st place in the Premier bracket. A loss makes us Premier runner-up (2nd place).',
  }],
];
export function chatAnswer(question, scenario) {
  const hit = CHAT_ANSWERS.find(([pattern]) => pattern.test(question));
  if (!hit) return 'I can help with the schedule, standings, brackets, and rules for the Harvest Moon Classic. Try asking when we play next!';
  return hit[1][scenario] || hit[1].any || hit[1].saturday;
}

// ---- weather (Open-Meteo shape) -----------------------------------------------------------------
export function weather() {
  const days = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'];
  const time = [], temperature_2m = [], windspeed_10m = [], winddirection_10m = [], weathercode = [];
  for (const day of days) for (let h = 0; h < 24; h++) {
    time.push(`${day}T${String(h).padStart(2, '0')}:00`);
    temperature_2m.push(Math.round(52 + 16 * Math.max(0, Math.sin((h - 7) / 24 * 2 * Math.PI))));
    windspeed_10m.push(4 + (h % 5));
    winddirection_10m.push(280);
    weathercode.push(h > 9 && h < 17 ? 1 : 0);
  }
  return {
    latitude:VENUE.lat, longitude:VENUE.lon, timezone:'America/Los_Angeles',
    hourly:{ time, temperature_2m, windspeed_10m, winddirection_10m, weathercode },
    daily:{ time:days, temperature_2m_min:days.map(() => 49), temperature_2m_max:days.map((_, i) => 68 + (i % 3)), weathercode:days.map(() => 1) },
  };
}

// ---- everything, built once ---------------------------------------------------------------------
export function buildDemo() {
  const scouting = buildReports();
  return {
    snapshots:{ saturday:scenarioSnapshot('saturday', scouting), sunday:scenarioSnapshot('sunday', scouting) },
    history:historySnapshot(),
    reports:Object.fromEntries(scouting.map(s => [s.report.opponent.id, s.report])),
  };
}
