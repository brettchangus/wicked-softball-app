import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function client(name, globals) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  const tail = source.slice(start);
  return vm.runInNewContext(`(${tail.slice(0, tail.search(/^}/m) + 1)})`, globals);
}
const snapshot = { meta:{ name:'Past tournament', providerTeamId:'ours' }, pools:{}, results:{} };
function setup(overrides = {}) {
  const globals = {
    APP_CONTEXT:{ teamKey:'our-team', seasonKey:'fall-2026' },
    SEASON_ARCHIVE_EVENTS:{ past:{ eventKey:'past-key', archived:false } },
    SEASON_ARCHIVE_FILES:{ past:'data/past.json' }, seasonSnapshotCache:new Map(),
    contextQuery:includeEvent => {
      assert.equal(includeEvent, false);
      return 'team=our-team&season=fall-2026';
    },
    AbortSignal, ...overrides,
  };
  return { globals, load:client('loadTournamentHistorySnapshot', globals) };
}

test('past tournaments in active seasons load their saved scoped results before static files', async () => {
  const calls = [];
  const { globals, load } = setup({ fetch:async url => {
    calls.push(url);
    return { ok:true, json:async () => snapshot };
  } });
  assert.equal(await load('past'), snapshot);
  assert.deepEqual(calls, ['/api/snapshot?team=our-team&season=fall-2026&eventKey=past-key']);
  assert.equal(await load('past'), snapshot);
  assert.equal(calls.length, 1);
  globals.APP_CONTEXT.seasonKey = 'summer-2026';
  await load('past');
  assert.equal(calls.length, 2, 'cached results belong to one team and season');
});

test('completed-season overlays prefer scoped snapshots with opponent edits applied', async () => {
  const edited = { ...snapshot, pools:{ A:{ teams:[{ id:'opp', name:'Edited Example Club' }] } },
    config:{ teamDisplay:{ opp:{ name:'Edited Example Club', providerName:'Provider Example Club' } } } };
  const calls = [];
  const { load } = setup({
    SEASON_ARCHIVE_EVENTS:{ past:{ eventKey:'past-key', archived:true } },
    loadSeasonArchiveBundle:async () => { throw new Error('archive fallback should not run'); },
    fetch:async url => { calls.push(url); return { ok:true, json:async () => edited }; },
  });
  assert.equal(await load('past'), edited);
  assert.deepEqual(calls, ['/api/snapshot?team=our-team&season=fall-2026&eventKey=past-key']);
  assert.equal(await load('past'), edited);
  assert.equal(calls.length, 1, 'the edited snapshot is cached');
});

test('completed-season overlays fall back to the archive when scoped snapshots are unavailable', async () => {
  for (const response of [null, { ok:false }, { ok:true, json:async () => ({ meta:{ schedulePending:true } }) },
    { ok:true, json:async () => ({ comingSoon:true }) }]) {
    const calls = [];
    const { load } = setup({
      SEASON_ARCHIVE_EVENTS:{ past:{ eventKey:'past-key', archived:true } },
      loadSeasonArchiveBundle:async () => { calls.push('archive'); return { events:{ 'past-key':{ snapshot } } }; },
      fetch:async url => {
        calls.push(url);
        if (!response) throw new Error('offline');
        return response;
      },
    });
    assert.equal(await load('past'), snapshot);
    assert.deepEqual(calls, ['/api/snapshot?team=our-team&season=fall-2026&eventKey=past-key', 'archive']);
  }
});

test('completed-season overlays use static snapshots when both scoped data and the archive are missing', async () => {
  const calls = [];
  const { load } = setup({
    SEASON_ARCHIVE_EVENTS:{ past:{ eventKey:'past-key', archived:true } },
    loadSeasonArchiveBundle:async () => { calls.push('archive'); return null; },
    fetch:async url => {
      calls.push(url);
      return url === 'data/past.json' ? { ok:true, json:async () => snapshot } : { ok:false };
    },
  });
  assert.equal(await load('past'), snapshot);
  assert.deepEqual(calls, ['/api/snapshot?team=our-team&season=fall-2026&eventKey=past-key', 'archive', 'data/past.json']);
});

test('unavailable or pending saved snapshots fall back to a committed tournament snapshot', async () => {
  for (const response of [null, { ok:false }, { ok:true, json:async () => ({ meta:{ schedulePending:true } }) }]) {
    const calls = [];
    const { load } = setup({ fetch:async url => {
      calls.push(url);
      if (url === 'data/past.json') return { ok:true, json:async () => snapshot };
      if (!response) throw new Error('offline');
      return response;
    } });
    assert.equal(await load('past'), snapshot);
    assert.equal(calls.length, 2);
  }
});

test('completed rows with saved event keys open the results overlay during an active season', () => {
  const container = { innerHTML:'' };
  const providerRef = 'https://allstartournaments.com/fastpitch/example-cup/';
  const build = client('buildSeason', {
    chronologicalSeasonRows:rows => rows,
    SEASON_DATA:[{ name:'Example Cup', key:'example-cup', status:'done', url:providerRef, providerRef }],
    seasonEventId:client('seasonEventId'),
    SEASON_ARCHIVE_EVENTS:{ [providerRef]:{ eventKey:'example-cup', archived:false } },
    SEASON_ARCHIVE_FILES:{}, historyEsc:String, jsArg:JSON.stringify,
    document:{ getElementById:() => container },
  });
  build();
  assert.match(container.innerHTML, /<button.*showTournamentHistory/);
  assert.match(container.innerHTML, /View completed schedule and standings/);
  assert.doesNotMatch(container.innerHTML, /<a class="t-row"/);
});

test('season event lookup uses saved provider references and recognizes legacy AST URLs', () => {
  const identify = client('seasonEventId');
  const url = 'https://allstartournaments.com/fastpitch/example-cup/';
  assert.equal(identify({ url }), url);
  assert.equal(identify({ url, providerRef:url }), url);
  assert.equal(identify({ url:'https://example.com', providerRef:'tm:tournament:division:team' }), 'tm:tournament:division:team');
  assert.equal(identify({ url:'https://norcal.registerplay.com/pages/event/123/456' }), '123');
  assert.equal(identify({ url:'https://tourneymachine.com/Public/Results/Division.aspx?IDTournament=t&IDDivision=d' }), 'tm:t:d');
});

test('missing saved data leaves the overlay open with an official-results link', async () => {
  const elements = Object.fromEntries(['historySource', 'historyTitle', 'historyMeta', 'historyBody', 'historyModal']
    .map(id => [id, { style:{}, classList:{ add(value) { this.value = value; } } }]));
  const show = client('showTournamentHistory', {
    SEASON_DATA:[{ key:'past', name:'Past tournament', url:'https://example.com/results' }],
    seasonEventId:row => row.key, historyEsc:String,
    document:{ getElementById:id => elements[id] },
    loadTournamentHistorySnapshot:async () => { throw new Error('unavailable'); },
  });
  await show('past');
  assert.equal(elements.historyModal.classList.value, 'open');
  assert.match(elements.historyBody.innerHTML, /saved tournament details could not be loaded/);
  assert.match(elements.historyBody.innerHTML, /href="https:\/\/example.com\/results"/);
});
