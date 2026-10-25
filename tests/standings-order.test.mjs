// Standings order and snapshot merging: NorCal's posted `place` becomes the official order, so the
// table matches NorCal's even when a team with an extra game has as many wins as teams with a better
// record; and a bracket game's score override reaches the bracket feed every bracket view reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import TournamentProjection from '../assets/projections.js';
import { mergeSnapshot, withPostedStandingsRanks } from '../netlify/functions/lib/snapshot.js';

const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function client(name, globals = {}) {
  const tail = source.slice(source.indexOf(`function ${name}(`));
  return vm.runInNewContext(`(${tail.slice(0, tail.search(/^}/m) + 1)})`,
    { TournamentProjection, SEEDING_RULES:null, projectionSnapshot:null, ...globals });
}
const row = (teamID, place, record) => ({ teamID, place, record });

test("NorCal's place becomes the official pool order once a game is played", () => {
  const rows = [row('sc', 1, '3-0'), row('rp', 6, '2-1'), row('st', 12, '2-2')];
  assert.deepEqual(withPostedStandingsRanks(rows, 1).map(s => [s.teamID, s.officialPoolRank, s.officialRank]),
    [['sc', 1, 1], ['rp', 6, 6], ['st', 12, 12]]);
  // Several pools: the place is only that pool's order.
  assert.deepEqual(withPostedStandingsRanks(rows, 2).map(s => s.officialRank), [null, null, null]);
  // Before any game every team is 0-0, so the order means nothing.
  const preEvent = [row('a', 1, '0-0'), row('b', 2, '0-0')];
  assert.equal(withPostedStandingsRanks(preEvent, 1), preEvent);
  // A row without a usable place leaves the whole pool unranked.
  const partial = [row('a', 1, '1-0'), row('b', null, '0-1')];
  assert.equal(withPostedStandingsRanks(partial, 1), partial);
  // Rows that already carry a rank (Tourney Machine) are left alone.
  const tm = [{ teamID:'a', place:2, record:'1-0', officialPoolRank:1, officialRank:1 }];
  assert.equal(withPostedStandingsRanks(tm, 1), tm);
  assert.deepEqual(withPostedStandingsRanks([], 1), []);
});

test('mergeSnapshot serves the posted order on each pool', () => {
  const snap = mergeSnapshot({ meta:{}, poolOrder:['A'], pools:{ A:{ teams:[], games:[] } } },
    { games:{}, standings:{ A:[row('sc', 1, '3-0'), row('st', 2, '2-2')] } }, {});
  assert.deepEqual(snap.pools.A.standings.map(s => s.officialPoolRank), [1, 2]);
});

test("standings follow NorCal's posted order, and fall back to wins then runs allowed without it", () => {
  const sort = client('sortStandingsTeams');
  // Field of Screams: Storm played a fourth game and allowed fewer runs than Rohnert Park.
  const teams = [
    { id:'storm', w:2, l:2, ra:13, rf:22 },
    { id:'rohnert', w:2, l:1, ra:14, rf:26 },
    { id:'select', w:2, l:1, ra:20, rf:19 },
    { id:'pacifica', w:1, l:2, ra:15, rf:13 },
  ];
  const posted = teams.map((t, i) => ({ ...t, officialPoolRank:[12, 6, 11, 13][i] }));
  assert.deepEqual([...sort(posted, 'officialPoolRank', true)].map(t => t.id), ['rohnert', 'select', 'storm', 'pacifica']);
  assert.deepEqual([...sort(teams, 'officialPoolRank', true)].map(t => t.id), ['storm', 'rohnert', 'select', 'pacifica']);
});

test('past-tournament standings follow the per-pool posted order', () => {
  const historyStandingsHtml = client('historyStandingsHtml', {
    historicalPoolRecord:() => ({ w:0, l:0, t:0, rf:0, ra:0 }), historyBadge:() => '',
    historyEsc:v => String(v ?? ''), trophyIcon:() => '', bracketTrophyPlace:() => 1,
  });
  const snap = ranks => ({ poolOrder:['A'], pools:{ A:{ label:'Pool A', teams:['storm', 'rohnert'].map(id => ({ id, name:id })),
    standings:[{ teamID:'storm', record:'2-2', PF:22, PA:13, officialPoolRank:ranks?.[0] },
      { teamID:'rohnert', record:'2-1', PF:26, PA:14, officialPoolRank:ranks?.[1] }] } } });
  const order = html => [...html.matchAll(/<span>(storm|rohnert)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(order(historyStandingsHtml(snap([2, 1]), 'x', 'y')), ['rohnert', 'storm']);
  assert.deepEqual(order(historyStandingsHtml(snap(null), 'x', 'y')), ['storm', 'rohnert']);
});

test("a bracket game's score override reaches the bracket feed, in the feed's top-team terms", () => {
  const live = { gold:[
    { key:'g2', gameNo:2, topId:'red', botId:'rp', topScore:null, botScore:null, status:'yet2Play' },
    { key:'g4', gameNo:4, topId:'red', botId:'us', topScore:null, botScore:null, status:null },
    { key:'g5', gameNo:5, topId:null, botId:null, topScore:null, botScore:null, status:null },
  ] };
  const snap = overrides => mergeSnapshot({ meta:{ providerTeamId:'us' }, poolOrder:[], pools:{}, brackets:[] },
    { games:{}, standings:{}, bracketGames:live }, overrides).bracketGames.gold;
  // Burlingame 4, Rohnert Park 3, entered as Final.
  const [g2] = snap({ g2:{ topScore:4, botScore:3, status:'completed' } });
  assert.deepEqual([g2.topScore, g2.botScore, g2.status], [4, 3, 'completed']);
  // "Win (Wicked)" with a score: the score decides.
  assert.equal(snap({ g4:{ topScore:2, botScore:5, status:'won' } })[1].status, 'completed');
  // A bare "Win (Wicked)" with us at the bottom: the top team lost.
  assert.equal(snap({ g4:{ status:'won' } })[1].status, 'lost');
  assert.equal(snap({ g4:{ status:'lost' } })[1].status, 'won');
  assert.equal(snap({ g5:{ topScore:1, botScore:1, status:'live' } })[2].status, 'live');
  // No override: the feed is served as is.
  assert.equal(mergeSnapshot({ meta:{}, poolOrder:[], pools:{}, brackets:[] }, { bracketGames:live }, {}).bracketGames, live);
  assert.equal(live.gold[0].topScore, null);   // the stored feed is never changed
});
