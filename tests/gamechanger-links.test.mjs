process.env.ADMIN_SECRET = 'test-admin-secret';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();
const { writeCatalog, writeTeam, writeSeason, writeStructure, readSeason, writeGameChangerRecords } =
  await import('../netlify/functions/lib/snapshot.js');
const admin = (await import('../netlify/functions/admin.js')).default;
const snapshot = (await import('../netlify/functions/snapshot.js')).default;
const { gameChangerLinksForContext, gameChangerOpponents, resolvedGameChangerLinks } =
  await import('../netlify/functions/lib/gamechanger.js');
const { gameChangerCandidates, gameChangerNameParts, gameChangerSearchTerms, searchGameChangerTeams } =
  await import('../netlify/functions/lib/gamechanger-search.js');

test('admin record refresh displays returned records even after a stale snapshot read', async () => {
  const source = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const start = source.indexOf("$('#gcRefreshRecords')?.addEventListener('click'");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start);
  const snap = { config:{ gameChangerRecords:{ opp:{ win:1, loss:1, tie:0 } } } };
  let click, displayed;
  vm.runInNewContext(source.slice(start, end), {
    $:() => ({ addEventListener:(_event, handler) => { click = handler; } }),
    confirmAction:async () => true,
    contextQuery:() => 'team=test&season=fall-2026',
    api:async action => {
      assert.equal(action, 'refreshGameChangerRecords');
      return { records:{ opp:{ win:2, loss:1, tie:0 } }, checked:1, changed:1, failed:0 };
    },
    run:async (request, message) => { const result = await request(); message(result); return result; },
    SNAP:snap,
    renderOpponents:() => { displayed = snap.config.gameChangerRecords.opp; },
  });
  await click();
  assert.deepEqual(displayed, { win:2, loss:1, tie:0 });
});

test('GameChanger candidates require matching name, age, and tournament season to auto-link', () => {
  const result = name => ({ type:'team', result:{ public_id:name.replaceAll(' ', ''), name,
    location:{ city:'Manteca', state:'CA' }, season:{ name:'Summer', year:2026 } } });
  const candidates = gameChangerCandidates([result('Batbusters Harrison 10U'), result('Batbusters Harrison 12U')],
    { name:'Batbusters Harrison', age:'10U', date:'2026-07-25' });
  assert.equal(candidates[0].autoMatch, true);
  assert.equal(candidates[1].autoMatch, false);
  assert.equal(gameChangerCandidates([{ ...result('Batbusters Harrison 10U'), result:{
    ...result('Batbusters Harrison 10U').result, season:{ name:'Fall', year:2026 } } }],
    { name:'Batbusters Harrison', age:'10U', date:'2026-07-25' })[0].autoMatch, false);
});

test('GameChanger search drops coach names, then broadens a zero-result search with city and age removed', async () => {
  assert.deepEqual(gameChangerNameParts('Example Outlaws 10U-Avina'),
    { team:'Example Outlaws 10U', coach:'Avina' });
  assert.deepEqual(gameChangerSearchTerms('Example Park Rebels Black-Coach Three'),
    ['Example Park Rebels Black', 'Park Rebels Black', 'Rebels Black']);
  const requests = [];
  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return Response.json({ hits:body.name === 'Outlaws' ? [
      { type:'team', result:{ public_id:'avina', name:'Outlaws 10U-Avina',
        location:{ city:'Example', state:'CA' }, season:{ name:'Fall', year:2026 } } },
      { type:'team', result:{ public_id:'lee', name:'Outlaws 10U-Lee',
        location:{ city:'Example', state:'CA' }, season:{ name:'Fall', year:2026 } } },
      { type:'team', result:{ public_id:'lee-plain', name:'Outlaws Lee 10U',
        location:{ city:'Example', state:'CA' }, season:{ name:'Fall', year:2026 } } },
    ] : [] });
  };
  const candidates = await searchGameChangerTeams('Example Outlaws 10U-Avina',
    { age:'10U', date:'2026-09-25', token:'test-token' }, fetchMock);
  assert.deepEqual(requests.map(request => request.name), ['Example Outlaws 10U', 'Outlaws']);
  assert.deepEqual(requests[0], { name:'Example Outlaws 10U', sport:'softball',
    include_older_seasons:false, states:['CA'], types:['team'],
    seasons:[{ name:'fall', year:2026 }] });
  assert.equal(candidates[0].name, 'Outlaws 10U-Avina');
  assert.equal(candidates[0].autoMatch, true);
  assert.equal(candidates[0].cityMatch, true);
  assert.equal(candidates[0].coachMatch, true);
  assert.equal(candidates[1].autoMatch, false);
  assert.equal(candidates[2].autoMatch, false);
});

test('ambiguous GameChanger profiles stay available for review without an automatic link', () => {
  const hits = ['one', 'two'].map(id => ({ type:'team', result:{ public_id:id,
    name:'Example Outlaws 10U', location:{ city:'Example', state:'CA' },
    season:{ name:'Fall', year:2026 } } }));
  const candidates = gameChangerCandidates(hits,
    { name:'Example Outlaws-Avina', age:'10U', date:'2026-09-25' });
  assert.equal(candidates.length, 2);
  assert.equal(candidates.filter(candidate => candidate.autoMatch).length, 2);
});

test('fallback searches combine distinct teams from both shorter names for review', async () => {
  const searched = [];
  const hit = (id, name) => ({ type:'team', result:{ public_id:id, name,
    location:{ city:'Example Park', state:'CA' }, season:{ name:'Fall', year:2026 } } });
  const fetchMock = async (_url, init) => {
    const { name } = JSON.parse(init.body);
    searched.push(name);
    return Response.json({ hits:name === 'Park Rebels Black' ? [hit('one', 'Rebels Black 10U-Coach Three')]
      : name === 'Rebels Black' ? [hit('one', 'Rebels Black 10U-Coach Three'), hit('two', 'Rebels Black 10U-Other')]
      : [] });
  };
  const candidates = await searchGameChangerTeams('Example Park Rebels Black-Coach Three',
    { age:'10U', date:'2026-10-10', token:'test-token' }, fetchMock);
  assert.deepEqual(searched, ['Example Park Rebels Black', 'Park Rebels Black', 'Rebels Black']);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].autoMatch, true);
  assert.equal(candidates[1].autoMatch, false);
});

test('Benicia search distinguishes the live Avina and Hill/Batchelder profiles', () => {
  const hits = [
    { type:'team', result:{ public_id:'example-coach-a', name:'Outlaws - Avina 10U',
      location:{ city:'Example', state:'CA' }, season:{ name:'Fall', year:2026 } } },
    { type:'team', result:{ public_id:'example-coach-b', name:'Outlaws Hill/Batchelder 10U',
      location:{ city:'Example', state:'CA' }, season:{ name:'Fall', year:2026 } } },
  ];
  const candidates = gameChangerCandidates(hits,
    { name:'Example Outlaws-Avina', age:'10U', date:'2026-09-25' });
  assert.equal(candidates[0].name, 'Outlaws - Avina 10U');
  assert.equal(candidates[0].autoMatch, true);
  assert.equal(candidates[1].autoMatch, false);
});

test('GameChanger links come from saved tournament config and can be cleared', () => {
  const context = { teamKey:'wicked-10b', seasonKey:'summer-2026', eventKey:'easton-classic' };
  const id = 'opponent';
  assert.deepEqual(gameChangerLinksForContext(context), {});
  assert.equal(gameChangerLinksForContext(context, { [id]:'https://web.gc.com/teams/example' })[id],
    'https://web.gc.com/teams/example');
  assert.equal(gameChangerLinksForContext(context, { [id]:null })[id], null);
});

test('pending AST registered teams can be linked before their provider ids are published', async () => {
  const scope = { teamKey:'gc-pending', seasonKey:'fall-2026', eventKey:'bat-wars' };
  await writeCatalog({ defaultTeamKey:scope.teamKey, teams:{
    [scope.teamKey]:{ key:scope.teamKey, name:'Wicked', defaultSeasonKey:scope.seasonKey,
      seasons:{ [scope.seasonKey]:{ key:scope.seasonKey, name:'Fall 2026', status:'active' } } },
  } });
  await writeTeam({ key:scope.teamKey, name:'Wicked', agePrefix:'10U', defaultSeasonKey:scope.seasonKey });
  await writeSeason({ teamKey:scope.teamKey, key:scope.seasonKey, name:'Fall 2026', status:'active',
    featuredEventKey:scope.eventKey,
    events:{ [scope.eventKey]:{ key:scope.eventKey, providerRef:'ast-event', config:{} } } });
  const pending = { meta:{ schedulePending:true, providerTeamId:'mine', dates:['2026-10-10'],
    ast:{ teamName:'Wicked Elite - Agar', teams:['Wicked Elite-Agar', 'Batbusters Harrison 10U'] } },
    pools:{}, brackets:[] };
  await writeStructure('ast-event', pending, scope);
  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=test-admin-secret', { method:'POST',
      headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...scope, ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  const state = await post({ action:'getState' });
  assert.deepEqual(state.body.gameChangerOpponents,
    [{ teamId:'name:batbustersharrison10u', name:'Batbusters Harrison 10U', possibleOpponent:true }]);
  const url = 'https://web.gc.com/teams/ABC123';
  assert.equal((await post({ action:'setGameChangerTeamLink', teamId:'name:batbustersharrison10u', url })).status, 200);
  assert.equal((await readSeason(scope.teamKey, scope.seasonKey)).events[scope.eventKey].config
    .gameChangerTeams['name:batbustersharrison10u'], url);
  const published = { meta:{ schedulePending:false, providerTeamId:'mine' },
    pools:{ A:{ teams:[{ id:'mine', name:'Wicked Elite - Agar' },
      { id:'opponent-id', name:'Batbusters Harrison 10U' }] } }, brackets:[] };
  await writeStructure('ast-event', published, scope);
  const publicSnap = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${scope.teamKey}&season=${scope.seasonKey}`))).json();
  assert.equal(publicSnap.config.gameChangerTeams['opponent-id'], url);
  assert.equal((await post({ action:'getState' })).body.config.events['ast-event'].gameChangerTeams['opponent-id'], url);
});

test('name-based links do not attach to two published teams with the same name', () => {
  const structure = { meta:{ providerTeamId:'mine' }, pools:{ A:{ teams:[
    { id:'one', name:'Same Team' }, { id:'two', name:'Same Team' },
  ] } }, brackets:[] };
  const links = resolvedGameChangerLinks(structure, { 'name:sameteam':'https://web.gc.com/teams/ABC123' });
  assert.equal(links.one, undefined);
  assert.equal(links.two, undefined);
  assert.equal(gameChangerOpponents(structure).length, 2);
});

test('AST links follow changed schedule names without overriding published edits', () => {
  const structure = { meta:{ ast:{ teams:['Example Valley Club-Coach One', 'Ohana Warriors-Sparks/Oelhafen',
    'Vibe-McLain/Brown', 'OutKasts-Medina', 'Example Outlaws-Avina', 'Example Outlaws-Hill/Batchelder'] } },
    pools:{ A:{ teams:[{ id:'cv', name:'Example Valley Club 10U - Coach One' },
      { id:'ohana', name:'Ohana Warriors 10u' }, { id:'vibe', name:'Vibe 10u McLain/Brown' },
      { id:'outkasts', name:'OutKasts' }, { id:'avina', name:'Example Outlaws 10u - Avina' },
      { id:'hill', name:'Example Outlaws 10U Hill/Batchelder' }] } } };
  const links = { 'name:examplevalleyclubcoachone':'cv-url', 'name:ohanawarriorssparksoelhafen':'ohana-url',
    'name:vibemclainbrown':'vibe-url', 'name:outkastsmedina':'outkasts-url',
    'name:exampleoutlawsavina':'avina-url', 'name:exampleoutlawshillbatchelder':'hill-url' };
  const resolved = resolvedGameChangerLinks(structure, links);
  for (const id of ['cv', 'ohana', 'vibe', 'outkasts', 'avina', 'hill']) assert.equal(resolved[id], id + '-url');
  assert.equal(resolvedGameChangerLinks(structure, { ...links, ohana:null }).ohana, null);
  assert.equal(resolvedGameChangerLinks(structure, { ...links, cv:'corrected' }).cv, 'corrected');
  assert.deepEqual(links, Object.fromEntries(Object.entries(resolved).filter(([key]) => key.startsWith('name:'))));
});

test('AST name promotion rejects ambiguous rosters, conflicting coaches and ages', () => {
  const resolve = (names, published) => resolvedGameChangerLinks({ meta:{ ast:{ teams:names } },
    pools:{ A:{ teams:published.map((name, i) => ({ id:String(i), name })) } } },
    Object.fromEntries(names.map(name => ['name:' + name.toLowerCase().replace(/[^a-z0-9]/g, ''), 'url'])));
  assert.equal(resolve(['OutKasts-Medina', 'OutKasts-Lee'], ['OutKasts'])['0'], undefined);
  assert.equal(resolve(['OutKasts-Medina'], ['OutKasts', 'OutKasts 10U'])['0'], undefined);
  assert.equal(resolve(['OutKasts-Medina'], ['OutKasts-Lee'])['0'], undefined);
  assert.equal(resolve(['OutKasts 10U-Medina'], ['OutKasts 12U-Medina'])['0'], undefined);
});

test('unassigned NorCal bracket slots (team id 0) are not opponents', () => {
  const structure = { meta:{ providerTeamId:'mine' }, pools:{ A:{ teams:[{ id:'one', name:'Real Team' }] } },
    brackets:[{ teams:[{ id:'0', name:'10U Pool P -  1st Overall' }],
      frame:[{ topId:'0', topName:'10U Pool P -  4th Overall', botId:'0', botName:'10U Pool P -  5th Overall' }] }] };
  assert.deepEqual(gameChangerOpponents(structure).map(t => t.teamId), ['one']);
});

test('confirmed GameChanger links are scoped, validated, served, and removable', async () => {
  const teamKey = 'gc-team', seasonKey = 'fall-2026', eventKey = 'classic';
  const scope = { teamKey, seasonKey, eventKey };
  await writeCatalog({ defaultTeamKey:teamKey, teams:{
    [teamKey]:{ key:teamKey, name:'GC Team', defaultSeasonKey:seasonKey,
      seasons:{ [seasonKey]:{ key:seasonKey, name:'Fall 2026', status:'active' } } },
  } });
  await writeTeam({ key:teamKey, name:'GC Team', agePrefix:'10U', defaultSeasonKey:seasonKey });
  await writeSeason({ teamKey, key:seasonKey, name:'Fall 2026', status:'active',
    featuredEventKey:eventKey, events:{ [eventKey]:{ key:eventKey, providerRef:'123', config:{} } } });
  await writeStructure('123', { meta:{ providerTeamId:'mine', dates:['2026-09-25'] }, poolOrder:['A'],
    pools:{ A:{ teams:[{ id:'mine', name:'Ours' }, { id:'opp', name:'Opponent' }], games:[] } }, brackets:[] }, scope);

  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=test-admin-secret', { method:'POST',
      headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...scope, ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  const url = 'https://web.gc.com/teams/ABC123/live';
  const ourUrl = 'https://web.gc.com/teams/OURTEAM?pid=Copy';
  assert.equal((await post({ action:'setEventConfig', config:{ gameChangerUrl:'https://evil.example/teams/OURTEAM' } })).status, 400);
  const beforeOwnLinkFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    assert.match(String(target), /\/public\/teams\/OURTEAM$/);
    return Response.json({ id:'OURTEAM', location:{ city:'Example City', state:'CA' },
      team_season:{ record:{ win:3, loss:1, tie:0 } } });
  };
  try {
    assert.equal((await post({ action:'setEventConfig', config:{ gameChangerUrl:ourUrl } })).status, 200);
  } finally { globalThis.fetch = beforeOwnLinkFetch; }
  assert.equal((await readSeason(teamKey, seasonKey)).teamConfig.gameChangerUrl, ourUrl);
  assert.equal((await post({ action:'getState' })).body.config.gameChangerUrl, ourUrl);
  const ownSnap = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  assert.equal(ownSnap.config.gameChangerUrl, ourUrl);
  assert.deepEqual(ownSnap.config.gameChangerRecords.mine, { win:3, loss:1, tie:0 });
  assert.deepEqual(ownSnap.config.gameChangerLocations.mine, { city:'Example City', state:'CA' });
  assert.equal((await post({ action:'setGameChangerTeamLink', teamId:'missing', url })).status, 400);
  assert.equal((await post({ action:'setGameChangerTeamLink', teamId:'opp', url:'https://evil.example/teams/ABC123' })).status, 400);
  const beforeLinkFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    assert.match(String(target), /\/public\/teams\/ABC123$/);
    return Response.json({ id:'ABC123', name:'Manual GC 10U', location:{ city:'Example', state:'CA' },
      team_season:{ record:{ win:4, loss:2, tie:0 } } });
  };
  try {
    assert.equal((await post({ action:'saveOpponent', teamId:'opp', fields:{ gcUrl:url, gcName:'' } })).status, 200);
    const manualState = (await post({ action:'getState' })).body;
    assert.equal(manualState.config.events[manualState.activeEventId].gameChangerTeamNames.opp, 'Manual GC 10U');
    assert.equal((await post({ action:'setGameChangerTeamLink', teamId:'opp', url, name:'Opponent GC 10U' })).status, 200);
  } finally { globalThis.fetch = beforeLinkFetch; }
  const linkedSnap = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  assert.deepEqual(linkedSnap.config.gameChangerRecords.opp, { win:4, loss:2, tie:0 });
  assert.deepEqual(linkedSnap.config.gameChangerLocations.opp, { city:'Example', state:'CA' });
  assert.equal((await readSeason(teamKey, seasonKey)).events[eventKey].config.gameChangerTeams.opp, url);
  assert.equal((await readSeason(teamKey, seasonKey)).events[eventKey].config.gameChangerTeamNames.opp, 'Opponent GC 10U');
  const stateWithName = (await post({ action:'getState' })).body;
  assert.equal(stateWithName.config.events[stateWithName.activeEventId].gameChangerTeamNames.opp, 'Opponent GC 10U');
  assert.equal((await post({ action:'setGameChangerTeamLink', teamId:'opp', url })).status, 200);
  assert.equal((await readSeason(teamKey, seasonKey)).events[eventKey].config.gameChangerTeamNames.opp, 'Opponent GC 10U');
  await writeGameChangerRecords(scope, { opp:{ url, record:{ win:5, loss:3, tie:1 },
    checkedAt:'2026-09-25T12:00:00Z' } });
  const publicSnap = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  assert.equal(publicSnap.config.gameChangerTeams.opp, url);
  assert.equal(publicSnap.config.gameChangerTeamNames.opp, 'Opponent GC 10U');
  assert.deepEqual(publicSnap.config.gameChangerRecords.opp, { win:5, loss:3, tie:1 });
  const beforeRefreshFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    const id = String(target).split('/').at(-1);
    assert.ok(['ABC123', 'OURTEAM'].includes(id));
    return Response.json({ id, location:{ city:id === 'ABC123' ? 'Example' : 'Example City', state:'CA' },
      team_season:{ record:id === 'ABC123'
      ? { win:6, loss:3, tie:1 } : { win:8, loss:2, tie:0 } } });
  };
  try {
    const refreshed = await post({ action:'refreshGameChangerRecords' });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.checked, 2);
    assert.equal(refreshed.body.changed, 2);
    assert.equal(refreshed.body.failed, 0);
    assert.deepEqual(refreshed.body.records.opp, { win:6, loss:3, tie:1 });
  } finally { globalThis.fetch = beforeRefreshFetch; }
  const refreshedSnap = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  assert.deepEqual(refreshedSnap.config.gameChangerRecords.opp, { win:6, loss:3, tie:1 });
  assert.deepEqual(refreshedSnap.config.gameChangerRecords.mine, { win:8, loss:2, tie:0 });
  assert.deepEqual(refreshedSnap.config.gameChangerLocations.opp, { city:'Example', state:'CA' });
  assert.equal((await post({ action:'setEventConfig', config:{ gameChangerUrl:'' } })).status, 200);
  assert.equal((await readSeason(teamKey, seasonKey)).teamConfig.gameChangerUrl, '');
  assert.equal((await post({ action:'clearGameChangerTeamLink', teamId:'opp' })).status, 200);
  assert.equal((await readSeason(teamKey, seasonKey)).events[eventKey].config.gameChangerTeams.opp, null);
  assert.equal((await readSeason(teamKey, seasonKey)).events[eventKey].config.gameChangerTeamNames.opp, null);
  const afterClear = await (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  assert.equal(afterClear.config.gameChangerRecords.opp, undefined);
  assert.equal(afterClear.config.gameChangerLocations.opp, undefined);
  const priorToken = process.env.GAMECHANGER_TOKEN, priorFetch = globalThis.fetch;
  process.env.GAMECHANGER_TOKEN = 'expired-token';
  const missingToken = await post({ action:'searchGameChangerTeam', teamId:'opp' });
  assert.equal(missingToken.status, 503);
  assert.match(missingToken.body.error, /Enter a GameChanger token/);
  let rejectSearch = true;
  globalThis.fetch = async (target, init) => {
    assert.match(String(target), /api\.team-manager\.gc\.com\/search\?start_at_page=0&search_source=search$/);
    assert.equal(init.headers['gc-token'], 'entered-token');
    assert.deepEqual(JSON.parse(init.body), { name:'Opponent', sport:'softball',
      include_older_seasons:false, states:['CA'], types:['team'],
      seasons:[{ name:'fall', year:2026 }] });
    if (rejectSearch) return new Response(JSON.stringify({ message:'Invalid search request' }),
      { status:400, headers:{ 'Content-Type':'application/json' } });
    return new Response(JSON.stringify({ hits:[{ type:'team', result:{ public_id:'ABC123',
      name:'Opponent 10U', season:{ name:'Fall', year:2026 }, location:{ city:'Manteca', state:'CA' } } }] }),
      { status:200, headers:{ 'Content-Type':'application/json' } });
  };
  try {
    const rejected = await post({ action:'autoFindGameChangerTeams', gcToken:'entered-token' });
    assert.equal(rejected.status, 502);
    assert.match(rejected.body.error, /GameChanger search failed \(400\): Invalid search request/);
    assert.doesNotMatch(JSON.stringify(rejected.body), /entered-token/);
    rejectSearch = false;
    const found = await post({ action:'searchGameChangerTeam', teamId:'opp', gcToken:'entered-token' });
    assert.equal(found.status, 200);
    assert.equal(found.body.candidates[0].autoMatch, true);
    assert.doesNotMatch(JSON.stringify(found.body), /entered-token/);
    const linked = await post({ action:'autoFindGameChangerTeams', gcToken:'entered-token' });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.matched.length, 1);
    assert.doesNotMatch(JSON.stringify(linked.body), /entered-token/);
    const savedSeason = await readSeason(teamKey, seasonKey);
    assert.doesNotMatch(JSON.stringify(savedSeason), /entered-token/);
    assert.equal(savedSeason.events[eventKey].config.gameChangerTeams.opp,
      'https://web.gc.com/teams/ABC123');
    assert.equal(savedSeason.events[eventKey].config.gameChangerTeamNames.opp, 'Opponent 10U');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.GAMECHANGER_TOKEN;
    else process.env.GAMECHANGER_TOKEN = priorToken;
  }
});
