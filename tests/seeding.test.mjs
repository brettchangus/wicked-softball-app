import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import projection from '../assets/projections.js';
import {
  AST_DEFAULT_SEEDING_RULES, normalizeSeedingRules, resolveSeedingRules, withSeedingRules,
} from '../netlify/functions/lib/seeding.js';

const team = id => ({ id, name: id });
const game = (key, hid, aid) => ({ key, hid, aid, hn: hid, an: aid });
const final = (topScore, botScore) => ({ status: 'completed', topScore, botScore });
const verified = tiebreakers => ({ verified: true, primary: 'winPercentage', allowsTies: false, tiebreakers });
const pool = (teams, games, results, projectionRules) =>
  ({ meta: { providerTeamId: 'W', projectionRules }, pools: { A: { teams: teams.map(team), games } }, results, brackets: [] });

// W and X tie at 1-1. W won their game but allowed more runs overall.
function twoTeamTie(tiebreakers) {
  return pool(['W', 'X', 'Y', 'Z'],
    [game('wx', 'W', 'X'), game('wy', 'W', 'Y'), game('xz', 'X', 'Z'), game('yz', 'Y', 'Z')],
    { wx: final(1, 0), wy: final(0, 10), xz: final(5, 0), yz: final(3, 1) }, verified(tiebreakers));
}

test('head-to-head settles a two-team tie before runs allowed', () => {
  const p = projection.poolPositions(twoTeamTie(['headToHead', 'runsAllowed']), 'W');
  assert.deepEqual([p.best, p.worst, p.candidates[0].conditional], [2, 2, false]);
});

test('tiebreakers apply in the configured order', () => {
  const p = projection.poolPositions(twoTeamTie(['runsAllowed', 'headToHead']), 'W');
  assert.deepEqual([p.best, p.worst], [3, 3]); // X allowed 1 run, W allowed 10.
});

test('head-to-head is skipped for a three-team tie; runs allowed decides', () => {
  // Cycle: W beat X, X beat Y, Y beat W. Pairwise head-to-head would put Y ahead of W.
  const s = pool(['W', 'X', 'Y'], [game('wx', 'W', 'X'), game('xy', 'X', 'Y'), game('yw', 'Y', 'W')],
    { wx: final(3, 0), xy: final(2, 1), yw: final(1, 0) }, verified(['headToHead', 'runsAllowed', 'runDifferential']));
  const p = projection.poolPositions(s, 'W');
  assert.deepEqual([p.best, p.worst, p.candidates[0].conditional], [1, 1, false]); // RA: W 1, Y 2, X 4.
});

test('a pending head-to-head game and the tie-group size across separate matchups are both respected', () => {
  // W 1-0, X 0-1, Y 1-0, Z 0-1, with W–X and Y–Z still to play.
  const s = pool(['W', 'X', 'Y', 'Z'], [game('wz', 'W', 'Z'), game('yx', 'Y', 'X'), game('wx', 'W', 'X'), game('yz', 'Y', 'Z')],
    { wz: final(3, 1), yx: final(4, 2) }, verified(['headToHead', 'runsAllowed']));
  const p = projection.poolPositions(s, 'W');
  const third = p.candidates.find(c => c.seed === 3);
  // X beats W and Y beats Z: W and X are the only 1-1 teams, and X won head-to-head.
  assert.equal(third.conditional, false);
  assert.deepEqual(third.witness.map(w => w.key + ':' + w.outcome).sort(), ['wx:away', 'yz:home']);
  assert.deepEqual([p.best, p.worst], [1, 4]);
  // Without head-to-head the same two-team tie stays open.
  const open = projection.poolPositions({ ...s, meta: { ...s.meta, projectionRules: verified(['runsAllowed']) } }, 'W');
  assert.equal(open.candidates.find(c => c.seed === 3).conditional, true);
});

test('verified rules are described in the outlook instead of the unverified warning', () => {
  const s = twoTeamTie(['headToHead', 'runsAllowed']);
  const text = projection.describe(projection.analyze(s, { myId: 'W' }));
  assert.match(text, /Seeding rules: Best record \(ties count as half a win\) → head-to-head \(two-team ties only\) → fewest runs allowed\./);
  assert.doesNotMatch(text, /not verified/);
});

test('admin rules win, AST tournaments default to AST rules, others stay unverified', () => {
  const custom = { primary: 'wins', allowsTies: false, tiebreakers: ['runsAllowed'] };
  assert.deepEqual(resolveSeedingRules({ config: { seedingRules: custom } }, { provider: 'norcal' }),
    { ...custom, verified: true, source: 'admin' });
  const ast = { ...AST_DEFAULT_SEEDING_RULES, tiebreakers: ['headToHead', 'runsAllowed', 'runDifferential'], verified: true, source: 'ast-default' };
  assert.deepEqual(resolveSeedingRules({ providerRef: 'https://allstartournaments.com/fastpitch/x/' }, {}), ast);
  assert.deepEqual(resolveSeedingRules({ discovery: { provider: 'ast' } }, {}), ast);
  // A published AST schedule is served as Tourney Machine but keeps its AST metadata.
  assert.deepEqual(resolveSeedingRules({}, { provider: 'tourneymachine', ast: {} }), ast);
  assert.equal(resolveSeedingRules({ providerRef: '1234567890' }, { provider: 'norcal' }), null);
  assert.equal(resolveSeedingRules({ providerRef: 'tm:a:b' }, { provider: 'tourneymachine' }), null);
});

test('withSeedingRules does not mutate the stored snapshot', () => {
  const snap = { meta: { provider: 'ast' }, pools: {} };
  const served = withSeedingRules(snap, {});
  assert.equal(served.meta.projectionRules.source, 'ast-default');
  assert.equal(snap.meta.projectionRules, undefined);
});

test('admin seeding rules are validated', () => {
  assert.equal(normalizeSeedingRules(null), null);
  assert.deepEqual(normalizeSeedingRules({ primary: 'winPercentage', tiebreakers: ['headToHead'] }),
    { primary: 'winPercentage', allowsTies: true, tiebreakers: ['headToHead'] });
  for (const bad of [[], 'wins', { primary: 'points' }, { primary: 'wins', tiebreakers: ['coinFlip'] },
    { primary: 'wins', tiebreakers: ['headToHead', 'headToHead'] }])
    assert.throws(() => normalizeSeedingRules(bad));
});

// ---- Current-standings ranking (the bracket tab's and chat's projected seed order) ----

const row = (id, w, l, extra = {}) => ({ id, name: id, w, l, ties: 0, ra: 0, rf: 0, ...extra });
const order = (teams, tiebreakers, snap, primary = 'winPercentage') =>
  projection.rankByRules(teams, { verified: true, primary, tiebreakers }, snap).map(t => t.id).join(',');

test('rankByRules: head-to-head breaks a two-team record tie, in configured order', () => {
  const snap = twoTeamTie([]);
  const teams = [row('X', 1, 1, { ra: 1, rf: 5 }), row('W', 1, 1, { ra: 10, rf: 1 }), row('Y', 2, 0), row('Z', 0, 2)];
  assert.equal(order(teams, ['headToHead', 'runsAllowed'], snap), 'Y,W,X,Z');
  assert.equal(order(teams, ['runsAllowed', 'headToHead'], snap), 'Y,X,W,Z');
});

test('rankByRules: head-to-head is skipped for a three-team tie, even after runs allowed narrows it', () => {
  // W beat X, X beat Y, Y beat W. Runs allowed: W 1, X and Y 2. X/Y stay tied, and
  // head-to-head (X beat Y) must not come back for the two left over.
  const snap = pool(['W', 'X', 'Y'], [game('wx', 'W', 'X'), game('xy', 'X', 'Y'), game('yw', 'Y', 'W')],
    { wx: final(3, 0), xy: final(2, 1), yw: final(1, 0) });
  const teams = [row('Y', 1, 1, { ra: 2, rf: 2 }), row('X', 1, 1, { ra: 2, rf: 1 }), row('W', 1, 1, { ra: 1, rf: 3 })];
  assert.equal(order(teams, ['headToHead', 'runsAllowed'], snap), 'W,X,Y');                    // X/Y: stable id order
  assert.equal(order(teams, ['headToHead', 'runsAllowed', 'runDifferential'], snap), 'W,Y,X'); // Y 0, X −1
});

test('rankByRules: best record counts a tie game as half a win; most wins does not', () => {
  const teams = [row('A', 2, 2), row('B', 2, 1, { ties: 1 })];
  assert.equal(order(teams, [], null), 'B,A');
  assert.equal(order(teams, [], null, 'wins'), 'A,B');                                          // tied on wins → id order
});

// ---- End to end: rules → pool position → bracket entry → Sunday outlook ----

// Gold takes global seeds 1–2, Silver 3–4. W and X finish 1-1; W won their game but allowed more runs.
const tiers = () => [
  { level: 'gold', label: 'Gold', size: 2, topologyKnown: true, frame: [{ key: 'g1', gameNo: 1, topSeed: 1, botSeed: 2 }] },
  { level: 'silver', label: 'Silver', size: 2, topologyKnown: true, frame: [{ key: 's1', gameNo: 2, topSeed: 1, botSeed: 2 }] },
];
function tieredBrackets(tiebreakers, meta = {}) {
  const s = twoTeamTie(tiebreakers);
  return { ...s, meta: { ...s.meta, ...meta }, brackets: tiers() };
}

test('the tiebreaker order decides which bracket the Sunday outlook places us in', () => {
  const h2h = projection.analyze(tieredBrackets(['headToHead', 'runsAllowed']), { myId: 'W' });
  assert.equal(h2h.headline, 'Highest finish still possible: Gold — 1st place');
  assert.ok(h2h.details.includes('Pool seed: #2.'));
  assert.deepEqual(h2h.best.steps, ['Win B1 vs Seed #1']);
  const ra = projection.analyze(tieredBrackets(['runsAllowed', 'headToHead']), { myId: 'W' });
  assert.equal(ra.headline, 'Highest finish still possible: Silver — 1st place');
  assert.ok(ra.details.includes('Pool seed: #3.'));
});

test('an AST tournament gets AST rules end to end; an unverified one leaves the tie conditional', () => {
  const unverified = tieredBrackets([], { projectionRules: undefined, provider: 'tourneymachine' });
  const ast = projection.analyze(withSeedingRules({ ...unverified, meta: { ...unverified.meta, ast: {} } }, {}), { myId: 'W' });
  assert.equal(ast.headline, 'Highest finish still possible: Gold — 1st place');              // head-to-head first
  assert.ok(ast.details.some(d => /^Seeding rules: Best record/.test(d)));
  const plain = projection.analyze(withSeedingRules(unverified, { providerRef: 'tm:a:b' }), { myId: 'W' });
  assert.match(plain.headline, /^Conditional ceiling: Gold/);
  assert.ok(plain.details.some(d => /not verified/.test(d)));
});

test('head-to-head settles a seed that depends on an unplayed game, and lists that game as required', () => {
  // W is done with 2 wins (beat X and Y, lost to V). X–V is unplayed: its winner ties W on 2 wins,
  // and head-to-head puts W first against X but second against V. Runs allowed can't settle it yet.
  const games = [game('wx', 'W', 'X'), game('wy', 'W', 'Y'), game('wv', 'W', 'V'), game('xy', 'X', 'Y'), game('xv', 'X', 'V'), game('yv', 'Y', 'V')];
  const results = { wx: final(2, 1), wy: final(4, 0), wv: final(0, 3), xy: final(5, 2), yv: final(6, 1) };
  const snap = tiebreakers => ({ ...pool(['W', 'X', 'Y', 'V'], games, results,
    { verified: true, primary: 'wins', allowsTies: false, tiebreakers }), brackets: tiers() });
  const seeds = result => result.positions.candidates.map(c => `${c.seed}${c.conditional ? '?' : ''}`).join(',');
  const h2h = projection.analyze(snap(['headToHead', 'runsAllowed']), { myId: 'W' });
  assert.equal(seeds(h2h), '1,2');
  assert.equal(h2h.headline, 'Highest finish still possible: Gold — 1st place');
  assert.ok(h2h.requirements.includes('X beats V.'));
  const ra = projection.analyze(snap(['runsAllowed']), { myId: 'W' });
  assert.equal(seeds(ra), '1?,2?');
  assert.match(ra.headline, /^Conditional ceiling: Gold/);
});

test('a manual win override counts for us even when we are the away team', () => {
  // The away team has a manual win override: home 0 – away 10.
  const s = pool(['W', 'O', 'B'], [game('p4', 'O', 'W'), game('bw', 'B', 'W'), game('bo', 'B', 'O')],
    { p4: { status: 'won', topScore: 0, botScore: 10, manual: true }, bw: final(9, 6), bo: final(13, 4) },
    verified(['headToHead']));
  assert.deepEqual([projection.poolPositions(s, 'W').best, projection.poolPositions(s, 'W').worst], [2, 2]);
  // Without scores the status alone is read from our side, and the ranking agrees.
  s.results.p4 = { status: 'won', manual: true };
  assert.equal(projection.poolPositions(s, 'W').best, 2);
  const rows = [row('B', 2, 0), row('O', 0, 2), row('W', 1, 1)];
  assert.equal(order(rows, ['headToHead'], s), 'B,W,O');
  s.results.p4 = { status: 'lost', manual: true };
  assert.equal(projection.poolPositions(s, 'W').best, 3);
  // A provider status (no manual flag) is the home/top team's result, as in NorCal bracket data.
  s.results.p4 = { status: 'won' };
  assert.equal(projection.poolPositions(s, 'W').best, 3);
});

// ---- Dashboard: the bracket tab's seed order follows the same rules ----

test('the dashboard standings/bracket order uses the seeding rules unless the provider posted ranks', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tail = html.slice(html.indexOf('function sortStandingsTeams('));
  const sort = rules => vm.runInNewContext('(' + tail.slice(0, tail.search(/^}/m) + 1) + ')',
    { TournamentProjection: projection, SEEDING_RULES: rules, projectionSnapshot: twoTeamTie([]) });
  const teams = () => [{ id: 'X', w: 1, l: 1, t: 0, ra: 1, rf: 5 }, { id: 'W', w: 1, l: 1, t: 0, ra: 10, rf: 1, me: true },
    { id: 'Y', w: 2, l: 0, t: 0 }, { id: 'Z', w: 0, l: 2, t: 0 }];
  const ids = list => list.map(t => t.id).join(',');
  assert.equal(ids(sort(null)(teams())), 'Y,X,W,Z');                                       // legacy: runs allowed
  assert.equal(ids(sort(verified(['headToHead', 'runsAllowed']))(teams())), 'Y,W,X,Z');   // head-to-head
  // A complete provider-posted order still wins over the rules.
  const posted = teams().map((t, i) => ({ ...t, officialRank: [2, 3, 1, 4][i] }));
  assert.equal(ids(sort(verified(['headToHead', 'runsAllowed']))(posted)), 'Y,X,W,Z');
  // The bracket note names the configured rules instead of a fixed claim.
  assert.match(html, /seeded by \$\{historyEsc\(TournamentProjection\.describeRules\(SEEDING_RULES\)/);
  assert.doesNotMatch(html, /ties within a pool use head-to-head first/);
});


test('dashboard division seeding keeps unrelated divisions out of head-to-head ties', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const extract = name => { const tail = html.slice(html.indexOf('function '+name+'(')); return tail.slice(0, tail.search(/^}/m)+1); };
  const globals = { TournamentProjection: projection, SEEDING_RULES: verified(['headToHead','runsAllowed']),
    projectionSnapshot: twoTeamTie([]), BRACKETS: [{division:'B'}, {division:'C'}] };
  globals.sortStandingsTeams = vm.runInNewContext('('+extract('sortStandingsTeams')+')', globals);
  const sort = vm.runInNewContext('('+extract('sortBracketTeams')+')', globals);
  const rows = [row('X',1,1,{level:'B',ra:1}), row('W',1,1,{level:'B',ra:10}),
    row('Y',2,0,{level:'B'}), row('Z',0,2,{level:'B'})];
  const ids = list => list.filter(t=>t.level==='B').map(t=>t.id).join(',');
  assert.equal(ids(sort(rows)), 'Y,W,X,Z');
  assert.equal(ids(sort([...rows,row('C',1,1,{level:'C'})])), 'Y,W,X,Z');
});

test('dashboard bracket projection puts our team first in an unresolved tie, like the standings', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const extract = name => { const tail = html.slice(html.indexOf('function '+name+'(')); return tail.slice(0, tail.search(/^}/m)+1); };
  // Pre-event: every team 0–0 with no posted ranks; our id sorts last.
  const teams = ['a','b','c','d','z'].map(id => ({ id, w: 0, l: 0, t: 0, ra: 0, rf: 0, level: 'B', me: id === 'z' }));
  for (const BRACKETS of [[{}], [{division:'B'}]]) {
    const globals = { TournamentProjection: projection, SEEDING_RULES: null, projectionSnapshot: null, BRACKETS };
    globals.sortStandingsTeams = vm.runInNewContext('('+extract('sortStandingsTeams')+')', globals);
    const sort = vm.runInNewContext('('+extract('sortBracketTeams')+')', globals);
    assert.equal(sort(teams)[0].id, 'z');
  }
});
