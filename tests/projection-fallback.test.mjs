import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function client(name, globals) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const tail = html.slice(start);
  return vm.runInNewContext(`(${tail.slice(0, tail.search(/^}/m) + 1)})`, globals);
}

test('standings still render without projection tools and keep official ranks authoritative', () => {
  const sort = client('sortStandingsTeams', {
    SEEDING_RULES:{ primary:'winPercentage', tiebreakers:['headToHead'] },
  });
  const rows = [{ id:'ours', w:1, ra:3 }, { id:'opponent', w:2, ra:5 }];
  assert.equal(sort(rows).map(t => t.id).join(','), 'opponent,ours');
  rows.forEach((row, i) => row.officialRank = i + 1);
  assert.equal(sort(rows).map(t => t.id).join(','), 'ours,opponent');
});

test('published pool labels remain usable without the projection script', () => {
  const globals = { POOL_KEYS:['A','B'] };
  const entryPool = client('bracketEntryPool', globals);
  assert.equal(entryPool({ topPool:'A' }, 'top'), 'A');
  assert.equal(entryPool({ botName:'Bracket B 2nd Place' }, 'bot'), 'B');
  globals.POOL_KEYS = ['A'];
  assert.equal(entryPool({ topPool:'A' }, 'top'), null);
});

test('missing projection tools preserve tournament initialization and published bracket rendering', () => {
  const elements = Object.fromEntries(['poolTabs','poolPanels','sbTabs','sbPanels','bktPanel-gold','projectionOutlook']
    .map(id => [id, { innerHTML:'', style:{} }]));
  const bracket = { level:'gold', label:'Championship', size:2, frame:[{
    gameNo:1, round:1, topId:'ours', topName:'Example Team', topSeed:1, topPool:'A',
    botId:'opponent', botName:'Example Opponents', botSeed:1, botPool:'B',
  }] };
  const globals = {
    document:{ getElementById:id => elements[id] || null },
    MY_NAME:'Example Team', MY_ID:'ours', SISTER_ID:null, CONTEXT_NORCAL_TEAM_ID:null,
    APP_CONTEXT:{}, SEASON_DATA:[], ACTIVE_SOURCE_URL:'',
    TOURNAMENT:{ name:'Example Cup', dates:[], venue:{} },
    POOL_KEYS:['A','B'], POOLS:{ A:{ label:'Pool A' }, B:{ label:'Pool B' } }, MY_POOL:'A', SISTER_POOL:null,
    TOURNEY_DAYS:[{ key:'sunday', label:'Sunday' }], BRACKET_DAY_KEY:'sunday',
    BRACKET_ONLY:false, BRACKETS:[bracket], BRACKET_SEEDED:{}, PROJECTION_UNSUPPORTED:false,
    SEEDING_RULES:{ primary:'winPercentage', tiebreakers:['headToHead'] },
    bracketGameData:{}, projectionSnapshot:{},
    historyEsc:String, jsArg:JSON.stringify, trophyIcon:() => '', bracketTrophyPlace:() => 1,
    bracketTeam:(id, name) => ({ id, name }),
    gameChangerLinkHtml:() => '', bracketScoutLinkHtml:() => '', bktGameHeader:() => '', fmtFrameTime:() => '',
    watchBracketTreeLayout:() => {},
    realOrPredicted:() => { throw new Error('must not predict seeds without the engine'); },
    renderSEBracket:() => { throw new Error('the published frame should render'); },
  };
  for (const name of ['formatTourneyDates','bracketEntryPool','btSlot','bracketResultOf',
    'renderFrameBracket','renderPlacementBracket','buildWickedScenarios']) {
    globals[name] = client(name, globals);
  }
  client('initTournamentUI', globals)();
  assert.match(elements.poolPanels.innerHTML, /panel-A/);
  assert.match(elements.sbPanels.innerHTML, /Projection tools could not load/);
  client('buildBrackets', globals)([{ id:'ours' }, { id:'opponent' }]);
  assert.match(elements['bktPanel-gold'].innerHTML, /Pool A #1 Example Team/);
  assert.match(elements['bktPanel-gold'].innerHTML, /Pool B #1 Example Opponents/);
  assert.match(elements.projectionOutlook.textContent, /Projection tools could not load/);
  assert.equal(globals.BRACKET_SEEDED.gold.teams.length, 0);
  bracket.placementGames = { championship:'B1' };
  assert.equal(globals.renderPlacementBracket('bktPanel-gold', bracket, [], 1), true);
  assert.match(elements['bktPanel-gold'].innerHTML, /Pool A #1 Example Team/);
});
