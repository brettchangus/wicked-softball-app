import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import projection from '../assets/projections.js';
import { buildTourneyMachineStructureFromParsed } from '../netlify/functions/lib/tourneymachine.js';

const team = id => ({ id, name: id });
const game = (key, hid, aid) => ({ key, hid, aid, hn: hid, an: aid });
const result = (topScore, botScore) => ({ status: 'completed', topScore, botScore });
const rules = { verified: true, primary: 'wins', allowsTies: false, tiebreakers: ['runsAllowed', 'runsScored'] };
function poolFixture() {
  return { meta: { providerTeamId: 'W', projectionRules: rules }, pools: { A: {
    teams: ['W', 'R', 'C', 'D'].map(team), games: [game('wc', 'W', 'C'), game('wd', 'W', 'D'), game('rd', 'R', 'D'), game('rc', 'R', 'C'), game('cd', 'C', 'D')],
  } }, results: { wc: result(1, 0), wd: result(0, 10), rd: result(1, 0), rc: result(0, 2) }, brackets: [] };
}
const seededFinal = { level: 'gold', label: 'Gold', size: 4, topologyKnown: true, frame: [
  { key: 'b1', gameNo: 1, topSeed: 1, botSeed: 4 },
  { key: 'b2', gameNo: 2, topSeed: 2, botSeed: 3 },
  { key: 'b3', gameNo: 3, topGame: 1, botGame: 2 },
] };

test('remaining opponents cannot both lose; finished tiebreaks cannot be overturned', () => {
  const p = projection.poolPositions(poolFixture(), 'W');
  assert.equal(p.best, 3); // R is permanently ahead and C or D must finish with two wins.
  assert.equal(p.worst, 4);
  assert.ok(p.candidates.every(c => c.witness.length === 1 && c.witness[0].key === 'cd'));
});

test('ties are enumerated only when the verified rules permit them', () => {
  const s = poolFixture(); s.meta.projectionRules = { ...rules, allowsTies: true };
  const p = projection.poolPositions(s, 'W');
  assert.equal(p.best, 2);
  assert.equal(p.candidates[0].witness[0].outcome, 'tie');
  assert.equal(p.candidates[0].conditional, true);
});

test('unverified rules and unsettled score tiebreaks never become exact claims', () => {
  const s = poolFixture(); delete s.meta.projectionRules; s.brackets = [{ ...seededFinal, size: 2, frame: [{ key: 'b1', gameNo: 1, topSeed: 1, botSeed: 2 }] }];
  const p = projection.analyze(s);
  assert.match(p.headline, /Conditional ceiling/);
  assert.match(projection.describe(p), /not verified/);
  assert.ok(p.requirements.some(s => /tiebreaks/.test(s)));
});

test('search limits cannot turn a partial search into a highest-finish claim', () => {
  const s = poolFixture(); s.brackets = [{ ...seededFinal, size: 2, frame: [{ key: 'b1', gameNo: 1, topSeed: 1, botSeed: 2 }] }];
  const p = projection.analyze(s, { maxNodes: 1 });
  assert.equal(p.best, null);
  assert.match(projection.describe(p), /Too many remaining/);
});

test('complete official pool ranks override assumptions, but not manual score overrides', () => {
  const s = poolFixture(); s.results.cd = result(3, 1);
  s.pools.A.standings = ['W', 'R', 'C', 'D'].map((teamID, i) => ({ teamID, officialPoolRank: i + 1 }));
  assert.equal(projection.poolPositions(s, 'W').best, 1);
  s.results.wc.manual = true;
  assert.notEqual(projection.poolPositions(s, 'W').best, 1);
});

test('stale standings are reported instead of assigning phantom remaining games', () => {
  const s = poolFixture(); s.pools.A.standings = [{ teamID: 'W', record: '2-0' }];
  assert.match(projection.poolPositions(s, 'W').reason, /not in sync/);
});

function multiPool() {
  return { meta: { providerTeamId: 'W', projectionUnsupported: true }, results: {
    pa: result(1, 0), pb: result(1, 0),
  }, pools: {
    A: { teams: ['W', 'A2'].map(team), games: [game('pa', 'W', 'A2')], standings: [{ teamID: 'W', officialPoolRank: 1 }, { teamID: 'A2', officialPoolRank: 2 }] },
    B: { teams: ['B1', 'B2'].map(team), games: [game('pb', 'B1', 'B2')], standings: [{ teamID: 'B1', officialPoolRank: 1 }, { teamID: 'B2', officialPoolRank: 2 }] },
  }, brackets: [{ level: 'championship', label: 'Gold / Silver', size: 4, topologyKnown: true, frame: [
    { key: 'b1', gameNo: 1, topPool: 'A', topSeed: 1, botPool: 'B', botSeed: 2 },
    { key: 'b2', gameNo: 2, topPool: 'B', topSeed: 1, botPool: 'A', botSeed: 2 },
    // Deliberately put the consolation at the SMALLER number: numbering is not a tier ranking.
    { key: 'b3', gameNo: 3, topGame: -1, botGame: -2 },
    { key: 'b9', gameNo: 9, topGame: 1, botGame: 2 },
  ] }] };
}

test('AST entries distinguish A1 from B1 and follow winner feeds to the championship', () => {
  const p = projection.analyze(multiPool());
  assert.equal(p.best.final, 9);
  assert.deepEqual(p.best.steps, ['Win B1 vs Pool B #2', 'Win B9 vs Winner of B2']);
  assert.match(p.headline, /Highest finish still possible: Championship \(final B9\)/);
  assert.ok(p.details.some(s => s.includes('Pool A')));
  assert.deepEqual(p.requirements, ['Win B1 vs Pool B #2', 'Win B9 vs Winner of B2']);
});

test('old multi-pool snapshots recover pool seeds from the provider labels', () => {
  const s = multiPool();
  for (const g of s.brackets[0].frame) for (const side of ['top', 'bot']) {
    if (g[side + 'Seed']) g[side + 'Name'] = `Bracket ${g[side + 'Pool']} ${g[side + 'Seed']}st Place`;
    g[side + 'Seed'] = null;
  }
  assert.equal(projection.analyze(s).best.final, 9);
});

test('a completed Sunday loss closes the championship path and follows consolation', () => {
  const s = multiPool();
  s.bracketGames = { championship: [{ key: 'b1', gameNo: 1, topId: 'W', botId: 'B2', ...result(0, 3) }] };
  const p = projection.analyze(s);
  assert.equal(p.best.final, 3);
  assert.deepEqual(p.best.steps, ['Win B3 vs Loser of B2']);
  assert.match(p.headline, /Consolation/);
  assert.equal(p.requirements.length, 1);
});

test('a completed final is a final result, not an upcoming win-out scenario', () => {
  const s = multiPool();
  s.bracketGames = { championship: [
    { key: 'b1', gameNo: 1, topId: 'W', botId: 'B2', ...result(0, 3) },
    { key: 'b3', gameNo: 3, topId: 'W', botId: 'B1', ...result(1, 4) },
  ] };
  const p = projection.analyze(s);
  assert.match(p.headline, /Final result: Consolation.*2nd place/);
  assert.deepEqual(p.requirements, []);
});

test('an assigned team has an outlook even when pool scenarios cannot be calculated', () => {
  const s = multiPool(); s.pools = {};
  s.bracketGames = { championship: [{ key: 'b1', gameNo: 1, topId: 'W', botId: 'B2', botName: 'B2', status: 'upcoming' }] };
  const p = projection.analyze(s);
  assert.equal(p.best.final, 9);
  assert.match(p.best.steps[0], /vs B2/);
});

test('missing links withhold the ceiling', () => {
  const s = multiPool(); s.brackets[0].frame.at(-1).topGame = 77;
  assert.equal(projection.analyze(s).best, null);
  assert.match(projection.describe(projection.analyze(s)), /links are missing/);
});

test('single-pool NorCal uses local seeds inside its global tier band', () => {
  const s = poolFixture(); s.results.cd = result(1, 0);
  s.pools.A.standings = ['C', 'R', 'W', 'D'].map((teamID, i) => ({ teamID, officialPoolRank: i + 1 }));
  s.brackets = ['Gold', 'Silver'].map(label => ({ label, level: label, size: 2,
    frame: [{ key: label, gameNo: 1, topSeed: 1, botSeed: 2 }] }));
  assert.match(projection.analyze(s).headline, /Silver.*1st place/);
});

test('provider structure preserves multi-pool seed identities for the shared engine', async () => {
  const games = [
    { key: 'p1', gameNo: 'P1', topId: 'W', topName: 'W', botId: 'a', botName: 'a', date: '2026-10-10' },
    { key: 'p2', gameNo: 'P2', topId: 'b', topName: 'b', botId: 'c', botName: 'c', date: '2026-10-10' },
    { key: 'b1', gameNo: 'B1', topName: 'Pool A 1st Place', botName: 'Pool B 1st Place', date: '2026-10-11' },
  ];
  const s = await buildTourneyMachineStructureFromParsed({ key: 'tm:t:d', divisionId: 'd' }, {
    games, standings: ['W', 'a', 'b', 'c'].map((teamID, i) => ({ teamID, pool: i < 2 ? 'A' : 'B' })),
  }, { canonicalTeamId: 'W', fetchTeamStatsFn: async () => null });
  assert.equal(s.meta.projectionUnsupported, true); // Legacy global slot renderer remains gated.
  assert.equal(s.brackets[0].frame[0].topSeed, 1);
  assert.equal(s.brackets[0].frame[0].botPool, 'B');
});

test('browser and server use identical projection output', () => {
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../assets/projections.js', import.meta.url), 'utf8'), browser);
  assert.equal(JSON.stringify(browser.TournamentProjection.analyze(multiPool())), JSON.stringify(projection.analyze(multiPool())));
});

test('a seed-independent championship ceiling survives the pool search limit', () => {
  const s = poolFixture(); s.brackets = [seededFinal];
  const p = projection.analyze(s, { maxNodes: 1 });
  assert.match(p.headline, /Highest finish still possible: Gold/);
  assert.ok(p.details.some(s => /Every pool seed/.test(s)));
  assert.ok(p.details.some(s => /Too many remaining/.test(s)));
  assert.equal(p.best.seed, null);
  assert.equal(p.requirements.length, 1);
});

test('per-division ranking excludes the sister division and uses its own bracket', () => {
  const s = multiPool();
  s.pools.A.teams.forEach(t => t.level = 'B'); s.pools.B.teams.forEach(t => t.level = 'C');
  s.brackets = ['B', 'C'].map(division => ({ level: division, division, label: `10${division}`, size: 2,
    frame: [{ gameNo: 1, topSeed: 1, botSeed: 2 }] }));
  const p = projection.analyze(s);
  assert.equal(p.positions.count, 2);
  assert.match(p.headline, /10B/);
  assert.ok(p.paths.every(p => p.bracket === '10B'));
});

test('cyclic brackets and unrecognized slots cannot fabricate a finish', () => {
  const s = multiPool(); s.brackets[0].frame[0].topGame = 9;
  assert.equal(projection.analyze(s).best, null);
  const missing = multiPool(); delete missing.brackets[0].frame[0].botSeed;
  assert.equal(projection.analyze(missing).best, null);
});

test('keyless NorCal frames join scores by absolute game number and honor overrides', () => {
  const s = multiPool(); s.meta.provider = 'norcal'; s.pools = {};
  s.brackets[0].frame.forEach(g => delete g.key);
  s.brackets[0].frame[2].gameNo = -3;
  s.bracketGames = { championship: [
    { gameNo: 2, topId: 'A2', botId: 'B1', ...result(0, 2) },
    { key: 'live1', gameNo: 1, topId: 'W', botId: 'B2', ...result(3, 0) },
  ] };
  s.results.live1 = { ...result(0, 3), manual: true };
  const p = projection.analyze(s);
  assert.equal(p.best.final, 3);
  assert.deepEqual(p.best.steps, ['Win G3 vs A2']);
});

test('dashboard escapes provider names and the chat formatter shares the same result', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const chat = fs.readFileSync(new URL('../netlify/functions/chat.js', import.meta.url), 'utf8');
  const extract = (source, name) => { const tail = source.slice(source.indexOf(`function ${name}(`)); return `(${tail.slice(0, tail.search(/^}/m) + 1)})`; };
  const s = multiPool(), panel = {};
  s.bracketGames = { championship: [{ key: 'b1', gameNo: 1, topId: 'W', botId: 'B2', botName: '<img onerror=bad>', status: 'upcoming' }] };
  vm.runInNewContext(extract(html, 'buildWickedScenarios'), {
    document: { getElementById: () => panel }, TournamentProjection: projection, projectionSnapshot: s, MY_ID: 'W', MY_NAME: 'W',
    historyEsc: s => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  })();
  assert.ok(panel.innerHTML.includes('&lt;img'));
  assert.ok(!panel.innerHTML.includes('<img'));
  const text = vm.runInNewContext(extract(chat, 'buildWickedScenarioContext'), { TournamentProjection: projection, MY_ID: 'W' })(s);
  assert.ok(text.endsWith(projection.describe(projection.analyze(s))));
});

function extractedFunction(source, name, globals) {
  const tail = source.slice(source.indexOf('function ' + name + '('));
  return vm.runInNewContext('(' + tail.slice(0, tail.search(/^}/m) + 1) + ')', globals);
}

test('many unfinished games across independent pools retain a complete seed range', () => {
  const s={meta:{providerTeamId:'W'},results:{},brackets:[],pools:{}};
  for(let i=0;i<13;i++) {
    const ids=i===0?['W','X','Y']:['A'+i,'B'+i,'C'+i];
    s.pools['P'+i]={teams:ids.map(team),games:[game('g'+i+'a',ids[0],ids[1]),game('g'+i+'b',ids[0],ids[2]),game('g'+i+'c',ids[1],ids[2])]};
  }
  const p=projection.poolPositions(s,'W');
  assert.equal(p.available,true);assert.equal(p.best,1);assert.equal(p.worst,p.count);
  const games=Object.values(s.pools).flatMap(pool=>pool.games);
  assert.ok(p.candidates.every(c=>c.witness.length===games.length));
  assert.ok(p.candidates.every(c=>new Set(c.witness.map(g=>g.key)).size===games.length));
});

test('component search agrees with exhaustive coupled outcomes and supplies valid witnesses', () => {
  for (const primary of ['wins', 'winPercentage']) for (const allowsTies of [false, true]) {
    const s = { meta: { projectionRules: { verified: true, primary, allowsTies } }, results: {}, brackets: [], pools: { A: {
      teams: ['W','A','B','C','D'].map(team),
      games: [game('wa','W','A'),game('ab','A','B'),game('wb','W','B'),game('cd1','C','D'),game('cd2','C','D')],
    } } };
    const games = s.pools.A.games, expected = new Map(), records = Object.fromEntries(s.pools.A.teams.map(t => [t.id, { w:0, ties:0, total:games.filter(g => g.hid === t.id || g.aid === t.id).length }]));
    const metric = t => primary === 'wins' ? t.w : (t.w + t.ties / 2) / t.total;
    const interval = () => {
      const diff = Object.entries(records).filter(([id]) => id !== 'W').map(([,t]) => metric(t) - metric(records.W));
      const ahead = diff.filter(d => d > 0).length, tied = diff.filter(d => d === 0).length;
      return { ahead, tied };
    };
    const apply = (g,outcome,delta) => {
      if(outcome === 'home') records[g.hid].w += delta;
      else if(outcome === 'away') records[g.aid].w += delta;
      else { records[g.hid].ties += delta; records[g.aid].ties += delta; }
    };
    function visit(i) {
      if(i === games.length) {
        const {ahead,tied} = interval();
        for(let seed=ahead+1;seed<=ahead+tied+1;seed++) expected.set(seed, (expected.get(seed) ?? true) && tied > 0);
        return;
      }
      for(const outcome of allowsTies ? ['home','away','tie'] : ['home','away']) { apply(games[i],outcome,1);visit(i+1);apply(games[i],outcome,-1); }
    }
    visit(0);
    const p = projection.poolPositions(s,'W');
    assert.deepEqual(p.candidates.map(c=>[c.seed,c.conditional]), [...expected].sort((a,b)=>a[0]-b[0]));
    for(const c of p.candidates) {
      c.witness.forEach(choice=>apply(games.find(g=>g.key===choice.key),choice.outcome,1));
      const {ahead,tied}=interval();
      assert.ok(c.seed >= ahead+1 && c.seed <= ahead+tied+1);
      c.witness.forEach(choice=>apply(games.find(g=>g.key===choice.key),choice.outcome,-1));
    }
  }
});

test('an unrelated missing or malformed sister bracket cannot erase an assigned final', () => {
  const s = { meta: { providerTeamId:'W', provider:'norcal' }, pools:{}, brackets:[
    { level:'B',division:'B',label:'10B',size:2,frame:[{ gameNo:1,topId:'W',botId:'R',...result(0,3) }] },
  ] };
  const expected=projection.analyze(s);
  for(const sister of [{level:'C',division:'C',frame:[]},{level:'C',division:'C',frame:[{gameNo:1,topGame:77}]}]) {
    s.brackets[1]=sister;
    const p=projection.analyze(s);
    assert.equal(p.headline,expected.headline);
    assert.equal(p.best.place,2);
    assert.deepEqual(p.details,expected.details);
  }
});

test('NorCal finals and required wins use the same G prefix', () => {
  const s=multiPool();s.meta.provider='norcal';
  assert.match(projection.analyze(s).headline,/final G9/);
  assert.match(projection.analyze(s).best.steps[0],/Win G1/);
});

function rendererGlobals(panel, s) {
  const globals={ document:{getElementById:()=>panel},TournamentProjection:projection,BRACKETS:s.brackets,
    bracketGameData:s.bracketGames || {},POOL_KEYS:Object.keys(s.pools || {}),MY_ID:'W',SISTER_ID:'S',
    bracketTeam:(id,name)=>({id,name}),historyEsc:v=>String(v).replaceAll('<','&lt;'),
    jsArg:JSON.stringify,bracketScoutLinkHtml:()=>'',bktGameHeader:()=>'',fmtFrameTime:()=>'',trophyIcon:()=>'',
    _normStatus:st=>st === 'completed' ? 'final' : st === 'upcoming' ? 'upcoming' : 'live',
    bracketTrophyPlace:()=>1,watchBracketTreeLayout:()=>{},
  };
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  globals.bracketEntryPool=extractedFunction(html,'bracketEntryPool',globals);
  globals.btSlot=extractedFunction(html,'btSlot',globals);
  globals.bracketResultOf=extractedFunction(html,'bracketResultOf',globals);
  return {html,globals};
}

test('fallback frame renderer preserves pool labels and joins scores by game number', () => {
  const s=multiPool(),panel={};s.brackets[0].frame.forEach(g=>g.round=g.gameNo<3?2:1);
  const {html,globals}=rendererGlobals(panel,s),render=extractedFunction(html,'renderFrameBracket',globals);
  render('panel',s.brackets[0].frame,[],1,'championship');
  assert.match(panel.innerHTML,/Pool A #1/);assert.match(panel.innerHTML,/Pool B #1/);
  Object.assign(s.brackets[0].frame[0],{topId:'W',topName:'W',botId:'B2',botName:'B2'});
  Object.assign(s.brackets[0].frame[1],{topId:'B1',topName:'B1',botId:'A2',botName:'A2'});
  globals.bracketGameData.championship=[
    {gameNo:1,topSeed:1,botSeed:2,topId:'W',botId:'B2',topName:'W',botName:'B2',...result(10,2)},
    {gameNo:2,topSeed:1,botSeed:2,topId:'B1',botId:'A2',topName:'B1',botName:'A2',...result(3,7)},
  ];
  render('panel',s.brackets[0].frame,[],1,'championship');
  assert.match(panel.innerHTML,/Pool A #1 W/);assert.match(panel.innerHTML,/Pool B #1 B1/);
  assert.match(panel.innerHTML,/bt-score win">10</);assert.match(panel.innerHTML,/bt-score win">7</);
  assert.match(panel.innerHTML,/bt-score lose">3</);
});

test('single-pool brackets keep projected teams despite pool-lettered slot labels', () => {
  const s={ meta:{ providerTeamId:'W' }, pools:{ A:{ teams:['W','R','C','D'].map(team), games:[] } },
    brackets:[{ level:'championship', label:'Championship', size:4, topologyKnown:true, placementGames:{championship:'B3'}, frame:[
      { key:'b1', gameNo:1, round:2, topName:'Bracket A 1st Place', topPool:'A', topSeed:1, botName:'Bracket A 4th Place', botPool:'A', botSeed:4 },
      { key:'b2', gameNo:2, round:2, topName:'Bracket A 2nd Place', topPool:'A', topSeed:2, botName:'Bracket A 3rd Place', botPool:'A', botSeed:3 },
      { key:'b3', gameNo:3, round:1, topGame:1, botGame:2 },
    ] }] };
  const projected=['W','R','C','D'].map(team),panel={};
  const {html,globals}=rendererGlobals(panel,s);
  extractedFunction(html,'renderPlacementBracket',globals)('panel',s.brackets[0],projected,1);
  assert.match(panel.innerHTML,/#1 W/);assert.match(panel.innerHTML,/#4 D/);
  assert.doesNotMatch(panel.innerHTML,/Bracket A 1st Place|Pool A #/);
  extractedFunction(html,'renderFrameBracket',globals)('panel',s.brackets[0].frame,projected,1,'championship');
  assert.match(panel.innerHTML,/#2 R/);assert.doesNotMatch(panel.innerHTML,/Bracket A 2nd Place|Pool A #/);
  Object.assign(s.brackets[0].frame[0],{topId:'W',topName:'W'});
  const chat=fs.readFileSync(new URL('../netlify/functions/chat.js',import.meta.url),'utf8');
  const text=extractedFunction(chat,'buildBracketFrameContext',{TournamentProjection:projection,MY_ID:'W',laDate:()=>''})(s);
  assert.match(text,/#1 W/);assert.doesNotMatch(text,/Pool A #/);
});

test('placement cards and chat qualify assigned seeds by pool', () => {
  const s=multiPool(),panel={};s.brackets[0].placementGames={gold:'B9',silver:'B3'};
  Object.assign(s.brackets[0].frame[0],{topId:'W',topName:'W',botId:'B2',botName:'B2'});
  Object.assign(s.brackets[0].frame[1],{topId:'B1',topName:'B1',botId:'A2',botName:'A2'});
  const {html,globals}=rendererGlobals(panel,s);
  extractedFunction(html,'renderPlacementBracket',globals)('panel',s.brackets[0],[],1);
  assert.match(panel.innerHTML,/Pool A #1 W/);assert.match(panel.innerHTML,/Pool B #1 B1/);
  const chat=fs.readFileSync(new URL('../netlify/functions/chat.js',import.meta.url),'utf8');
  const text=extractedFunction(chat,'buildBracketFrameContext',{TournamentProjection:projection,MY_ID:'W',laDate:()=>''})(s);
  assert.match(text,/Pool A #1 W/);assert.match(text,/Pool B #1 B1/);
});
