process.env.ADMIN_SECRET = 'test-admin-secret';
// Opponent display properties (name / coach / city / state): the pure resolver in
// lib/opponents.js, plus the admin saveOpponent action and what the public snapshot serves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';
import { splitFixture, noGeocode } from './fixtures/norcal.mjs';

installMemoryBlobStore();
const { writeCatalog, writeTeam, writeSeason, writeStructure, writeResults, readSeason, readGameChangerRecords, writeGameChangerRecords } =
  await import('../netlify/functions/lib/snapshot.js');
const admin = (await import('../netlify/functions/admin.js')).default;
const snapshot = (await import('../netlify/functions/snapshot.js')).default;
const {
  applyTeamDisplay, normalizeOpponentFields, opponentRows, opponentSearchInput, providerTeamLocations,
  registeredTeamLabels, resolveTeamDisplay, splitRosterName, teamDisplayMap,
  defaultLocation, editedTeamLabels, withRecentResultNames,
} = await import('../netlify/functions/lib/opponents.js');
const { loadTeamDisplay } = await import('../netlify/functions/lib/team-display.js');
const { buildScheduleContext } = await import('../netlify/functions/chat.js');
const { gameChangerCandidates, searchGameChangerTeams } =
  await import('../netlify/functions/lib/gamechanger-search.js');
const { refreshGameChangerRecords } = await import('../netlify/functions/lib/gamechanger-records.js');
const { buildStructure, teamLocationFrom, teamRegisteredLevel } = await import('../netlify/functions/lib/norcal.js');

test('roster names split into team and coach the same way the dashboard does', () => {
  assert.deepEqual(splitRosterName('Example Opponents A 10U-Sample Coach'), { team:'Example Opponents A 10U', coach:'Sample Coach' });
  assert.deepEqual(splitRosterName('Example Club 10U (Sample Coach)'), { team:'Example Club 10U', coach:'Sample Coach' });
  assert.deepEqual(splitRosterName('Example-Region Club 10B'), { team:'Example-Region Club 10B', coach:'' });
});

test('display values prefer the override, then the provider, then the GameChanger profile', () => {
  const provider = { city:'Example City B', state:'CA' }, gameChanger = { city:'Example City C', state:'California' };
  const plain = resolveTeamDisplay('Example Club B 10U - Provider Coach', { provider, gameChanger });
  assert.deepEqual([plain.name, plain.coach, plain.city, plain.state], ['Example Club B 10U', 'Provider Coach', 'Example City B', 'CA']);
  assert.equal(plain.label, 'Example Club B 10U - Provider Coach');
  assert.deepEqual(plain.override, {});
  assert.deepEqual(resolveTeamDisplay('Example Club B 10U', { gameChanger }).defaults,
    { name:'Example Club B 10U', coach:'', city:'Example City C', state:'CA' });

  const edited = resolveTeamDisplay('Example Club B 10U - Provider Coach',
    { override:{ name:'Example Club', city:'Example City D', coach:'' }, provider, gameChanger });
  assert.deepEqual([edited.name, edited.coach, edited.city, edited.state], ['Example Club', 'Provider Coach', 'Example City D', 'CA']);
  assert.equal(edited.label, 'Example Club - Provider Coach');
  assert.deepEqual(edited.override, { name:'Example Club', city:'Example City D' });
  assert.deepEqual(edited.defaults, { name:'Example Club B 10U', coach:'Provider Coach', city:'Example City B', state:'CA' });
});

test('a partial provider location is completed from GameChanger without mixing two places', () => {
  const gameChanger = { city:'Example City A', state:'California' };
  // The provider knows only a state: GameChanger names the city, so it is the place.
  assert.deepEqual(defaultLocation({ city:'', state:'CA' }, gameChanger), { city:'Example City A', state:'CA' });
  assert.deepEqual(defaultLocation({ state:'NV' }, gameChanger), { city:'Example City A', state:'CA' });
  // The provider knows only a city: GameChanger's state is borrowed when it names the same city…
  assert.deepEqual(defaultLocation({ city:'example city a' }, gameChanger), { city:'example city a', state:'CA' });
  // …but not when it names another one — "Example City E, CA" is a place neither source gave.
  assert.deepEqual(defaultLocation({ city:'Example City E' }, gameChanger), { city:'Example City E', state:'' });
  assert.deepEqual(defaultLocation({ city:'Example City F', state:'NV' }, gameChanger), { city:'Example City F', state:'NV' });
  assert.deepEqual(defaultLocation(null, { state:'CA' }), { city:'', state:'CA' });
  assert.deepEqual(defaultLocation(null, null), { city:'', state:'' });
  const shown = resolveTeamDisplay('Example Opponents A 10U', { provider:{ state:'CA' }, gameChanger });
  assert.deepEqual(shown.defaults, { name:'Example Opponents A 10U', coach:'', city:'Example City A', state:'CA' });
  // An admin's own city or state still wins field by field.
  const edited = resolveTeamDisplay('Example Opponents A 10U', { override:{ state:'OR' }, provider:{ city:'Example City E' }, gameChanger });
  assert.deepEqual([edited.city, edited.state], ['Example City E', 'OR']);
});

test('recent results rename an opponent only in the tournament where it was edited', () => {
  const ours = { season:'3-1', games:[
    { eventId:'evt-1', oppId:'opp', opp:'Example Club B 10U - Provider Coach', score:'5-1' },
    { eventId:'evt-2', oppId:'opp', opp:'Example Club B 10U - Provider Coach', score:'2-3' },
    { eventId:'evt-1', oppId:'two', opp:'Example Club A 10B', score:'4-4' },
  ] };
  const labels = editedTeamLabels(teamDisplayMap(structure(), { opp:{ name:'Example Club' }, two:{ city:'Example City I' } }));
  assert.deepEqual(labels, { opp:'Example Club - Provider Coach' });
  const shown = withRecentResultNames(ours, { 'evt-1':labels });
  assert.deepEqual(shown.games.map(game => game.opp), ['Example Club - Provider Coach', 'Example Club B 10U - Provider Coach', 'Example Club A 10B']);
  assert.equal(shown.season, '3-1');
  assert.equal(ours.games[0].opp, 'Example Club B 10U - Provider Coach', 'the source is not mutated');
  assert.equal(withRecentResultNames(ours, { 'evt-1':{} }), ours);
  assert.equal(withRecentResultNames(null, { 'evt-1':labels }), null);
});

test('a registered-team list prints edited names without changing the names it is keyed by', () => {
  const pending = { meta:{ schedulePending:true, providerTeamId:'mine',
    ast:{ teamName:'Example Home Team-Sample Coach', teams:['Example Home Team-Sample Coach', 'Example Opponents A-Sample Coach', 'Example Opponents B-Other Coach'] } },
    pools:{}, brackets:[] };
  const display = teamDisplayMap(pending, { 'name:exampleopponentsasamplecoach':{ name:'Example Opponents A', coach:'Updated Coach' },
    'name:exampleopponentsbothercoach':{ city:'Example City J' } });
  assert.deepEqual(registeredTeamLabels(pending.meta.ast.teams, display),
    ['Example Home Team-Sample Coach', 'Example Opponents A - Updated Coach', 'Example Opponents B-Other Coach']);
  assert.deepEqual(pending.meta.ast.teams[1], 'Example Opponents A-Sample Coach');
  // Once published, the same list is matched to the teams' ids by provider name; a name two
  // teams share is left alone.
  const published = { meta:{ providerTeamId:'mine' }, pools:{ A:{ teams:[{ id:'mine', name:'Example Home Team-Sample Coach' },
    { id:'b', name:'Example Opponents A-Sample Coach' }, { id:'s1', name:'Same Team' }, { id:'s2', name:'Same Team' }] } }, brackets:[] };
  const shown = teamDisplayMap(published, { b:{ name:'Example Opponents A' }, s1:{ name:'First' } });
  assert.deepEqual(registeredTeamLabels(['Example Opponents A-Sample Coach', 'Same Team', 'Unknown'], shown),
    ['Example Opponents A - Sample Coach', 'Same Team', 'Unknown']);
  assert.match(buildScheduleContext({ meta:{ ...pending.meta,
    ast:{ ...pending.meta.ast, teams:registeredTeamLabels(pending.meta.ast.teams, display) } } }),
    /Registered teams, 3: Example Home Team-Sample Coach; Example Opponents A - Updated Coach; Example Opponents B-Other Coach/);
});

test('chat and push resolve a team from the same saved GameChanger location the snapshot uses', async () => {
  const scope = { teamKey:'display-team', seasonKey:'fall-2026', eventKey:'classic' };
  const url = 'https://web.gc.com/teams/EXAMPLE123';
  await writeGameChangerRecords(scope, { opp:{ url, record:{ win:1, loss:0, tie:0 }, location:{ city:'Example City F', state:'NV' } } });
  const tournament = { meta:{ providerTeamId:'mine' },
    pools:{ A:{ teams:[{ id:'mine', name:'Ours' }, { id:'opp', name:'Example Club 10B - Example City F' }] } }, brackets:[] };
  const display = await loadTeamDisplay(scope, tournament, { opponents:{ opp:{ name:'Example Club' } }, links:{ opp:url } });
  // The suffix is the linked profile's city, so it is not a coach — on every surface.
  assert.deepEqual([display.opp.label, display.opp.coach, display.opp.city, display.opp.state], ['Example Club', '', 'Example City F', 'NV']);
  assert.equal(teamDisplayMap(tournament, { opp:{ name:'Example Club' } }).opp.label, 'Example Club - Example City F',
    'without the saved location the suffix would read as a coach');
  assert.equal((await loadTeamDisplay(null, tournament, { opponents:{ opp:{ name:'Example Club' } } })).opp.label, 'Example Club - Example City F');
});

test('a roster suffix that is the team\'s city is not shown as its coach', () => {
  const ours = resolveTeamDisplay('Ours 10B - Example City G', { provider:{ city:'Example City G', state:'CA' } });
  assert.equal(ours.coach, '');
  assert.equal(ours.defaults.coach, '');
  // Untouched names keep the provider's full label, so two teams told apart by suffix stay distinct.
  assert.equal(ours.label, 'Ours 10B - Example City G');
  // No known city: the suffix is still treated as the coach, and a city override turns it off.
  assert.equal(resolveTeamDisplay('Example Club 10B - Example City H').coach, 'Example City H');
  assert.equal(resolveTeamDisplay('Example Club 10B - Example City H', { override:{ city:'example city h' } }).coach, '');
  assert.equal(resolveTeamDisplay('Example Club 10B - Example City H', { override:{ city:'Example City H', coach:'Custom Coach' } }).label, 'Example Club 10B - Custom Coach');
});

test('overrides are validated field by field', () => {
  assert.deepEqual(normalizeOpponentFields({ name:'  Example   Hawks ', state:'ca', other:'x' }),
    { fields:{ name:'Example Hawks', state:'CA' } });
  assert.deepEqual(normalizeOpponentFields({ coach:'', state:'' }), { fields:{ coach:'', state:'' } });
  assert.match(normalizeOpponentFields({ state:'Calif' }).error, /two-letter state/);
});

const structure = () => ({
  meta:{ providerTeamId:'mine' }, poolOrder:['A'],
  pools:{ A:{ teams:[{ id:'mine', name:'Ours 10B - Home', city:'Home', state:'CA' },
    { id:'opp', name:'Example Club B 10U - Provider Coach', city:'Example City B', state:'CA' },
    { id:'two', name:'Example Club A 10B' }],
    games:[{ key:'g1', hid:'mine', hn:'Ours 10B - Home', aid:'opp', an:'Example Club B 10U - Provider Coach' }],
    standings:[{ teamID:'opp', team:'Example Club B 10U - Provider Coach', record:'1-0' }] } },
  brackets:[{ level:'gold', teams:[{ id:'opp', name:'Example Club B 10U - Provider Coach', seed:1 }],
    frame:[{ gameNo:1, topId:'opp', topName:'Example Club B 10U - Provider Coach', botId:null, botName:'W-3' }] }],
  bracketGames:{ gold:[{ key:'b1', topId:'two', topName:'Example Club A 10B', botId:'opp', botName:'Example Club B 10U - Provider Coach' }] },
});

test('edited names are applied by team id everywhere a merged snapshot prints them', () => {
  const snap = structure();
  const display = teamDisplayMap(snap, { opp:{ name:'Example Club', coach:'Edited Coach' }, mine:{ name:'Not Us' } },
    { two:{ city:'Example City I', state:'CA' } });
  assert.equal(display.mine.name, 'Ours 10B', 'our own team is never overridden');
  assert.equal(display.mine.coach, '');
  assert.deepEqual([display.two.city, display.two.state], ['Example City I', 'CA']);
  const shown = applyTeamDisplay(snap, display);
  assert.equal(shown.pools.A.teams[1].name, 'Example Club - Edited Coach');
  assert.equal(shown.pools.A.games[0].an, 'Example Club - Edited Coach');
  assert.equal(shown.pools.A.games[0].hn, 'Ours 10B - Home');
  assert.equal(shown.pools.A.standings[0].team, 'Example Club - Edited Coach');
  assert.equal(shown.brackets[0].teams[0].name, 'Example Club - Edited Coach');
  assert.equal(shown.brackets[0].frame[0].topName, 'Example Club - Edited Coach');
  assert.equal(shown.brackets[0].frame[0].botName, 'W-3');
  assert.equal(shown.bracketGames.gold[0].botName, 'Example Club - Edited Coach');
  assert.equal(shown.bracketGames.gold[0].topName, 'Example Club A 10B');
  assert.equal(snap.pools.A.teams[1].name, 'Example Club B 10U - Provider Coach', 'the source is not mutated');
  assert.equal(applyTeamDisplay(snap, teamDisplayMap(snap, { opp:{ city:'Example City D' } })), snap,
    'a location-only edit rewrites no names');
});

test('the admin list carries resolved values, provider defaults and overrides for each opponent', () => {
  const rows = opponentRows(structure(), { opp:{ coach:'Edited Coach' } });
  assert.deepEqual(rows.map(row => row.teamId), ['two', 'opp']);
  const row = rows[1];
  assert.equal(row.providerName, 'Example Club B 10U - Provider Coach');
  assert.deepEqual([row.name, row.coach, row.city, row.state], ['Example Club B 10U', 'Edited Coach', 'Example City B', 'CA']);
  assert.deepEqual(row.defaults, { name:'Example Club B 10U', coach:'Provider Coach', city:'Example City B', state:'CA' });
  assert.deepEqual(row.override, { coach:'Edited Coach' });
  assert.deepEqual(providerTeamLocations(structure()).opp, { city:'Example City B', state:'CA' });
});

test('an override saved against a pending name follows the team to its published id', () => {
  const published = { meta:{ providerTeamId:'mine' },
    pools:{ A:{ teams:[{ id:'mine', name:'Ours' }, { id:'real-id', name:'Example Travel 10U' }] } }, brackets:[] };
  const display = teamDisplayMap(published, { 'name:exampletravel10u':{ city:'Example Venue City', state:'CA' } });
  assert.deepEqual([display['real-id'].city, display['real-id'].state], ['Example Venue City', 'CA']);
});

test('GameChanger searches match on edited fields first, then the provider\'s', () => {
  assert.deepEqual(opponentSearchInput('Example Opponents A 10U-Sample Coach'),
    { name:'Example Opponents A 10U-Sample Coach', city:'', state:'' });
  assert.deepEqual(opponentSearchInput('Example Club 10B - Example City F', { provider:{ city:'Example City F', state:'NV' } }),
    { name:'Example Club 10B', team:'Example Club 10B', coach:'', city:'Example City F', state:'NV' });
  assert.deepEqual(opponentSearchInput('Example Club 10B', { override:{ coach:'Sample Coach', state:'OR' }, provider:{ city:'Example City F', state:'NV' } }),
    { name:'Example Club 10B - Sample Coach', team:'Example Club 10B', coach:'Sample Coach', city:'Example City F', state:'OR' });
});

test('a known city and state reach the GameChanger search and count as a city match', async () => {
  const hit = (id, name, city) => ({ type:'team', result:{ public_id:id, name,
    location:{ city, state:'NV' }, season:{ name:'Fall', year:2026 } } });
  const options = { name:'Example Club 10B', team:'Example Club 10B', coach:'', age:'10U', date:'2026-09-25', state:'NV' };
  const [exampleCity, otherCity] = gameChangerCandidates([hit('exampleCity', 'Example Club Elite 10B', 'Example City F'), hit('otherCity', 'Example Club Elite 10B', 'Example City K')],
    { ...options, city:'Example City F' });
  assert.deepEqual([exampleCity.cityMatch, exampleCity.autoMatch], [true, true]);
  assert.deepEqual([otherCity.cityMatch, otherCity.autoMatch], [false, false]);
  let request;
  await searchGameChangerTeams('Example Club 10B', { ...options, city:'Example City F', token:'t' }, async (_url, init) => {
    request = JSON.parse(init.body);
    return Response.json({ hits:[] });
  });
  assert.deepEqual(request.states, ['NV']);
});

test('NorCal setup stamps each team\'s home city and state from its profile', async () => {
  assert.deepEqual(teamLocationFrom({ info:{ city:' Example City G ', state:'CA' } }), { city:'Example City G', state:'CA' });
  assert.equal(teamLocationFrom({ info:{ name:'No Location' } }), null);
  const { fetchJson } = splitFixture();
  const built = await buildStructure('evt', { myId:'ours', divisionIds:['divB', 'divC'], fetchJson, geocodeFn:noGeocode,
    fetchTeamStatsFn:async id => ({ season:'1-0', level:'B', location:id === 'b2' ? { city:'Example City A', state:'CA' } : null }) });
  const teams = Object.values(built.pools).flatMap(pool => pool.teams);
  assert.deepEqual(providerTeamLocations(built), { b2:{ city:'Example City A', state:'CA' } });
  assert.equal(teams.find(team => team.id === 'ours').city, undefined);
});

test('NorCal setup keeps a team\'s registered level apart from its bracket level', async () => {
  // info.teamClass is there before a team has played; apex (and so `level`) is not.
  assert.equal(teamRegisteredLevel({ info:{ teamClass:'10-B' } }), 'B');
  assert.equal(teamRegisteredLevel({ info:{ teamClass:'10-C' }, apex:{ teamClass:'C' } }), 'C');
  assert.equal(teamRegisteredLevel({ info:{ teamClass:'10-Rec' } }), null);
  assert.equal(teamRegisteredLevel({ info:{ teamClass:'10-Open' } }), null);
  assert.equal(teamRegisteredLevel({}), null);
  const { fetchJson } = splitFixture();
  // Pool C teams: c1 has played (apex level C); c2 has not, and is registered B while placed in C.
  const built = await buildStructure('evt', { myId:'ours', divisionIds:['divB', 'divC'], fetchJson, geocodeFn:noGeocode,
    fetchTeamStatsFn:async id => ({ season:'0-0', level:id === 'c1' ? 'C' : null, registeredLevel:id === 'c2' ? 'B' : 'C' }) });
  const team = id => Object.values(built.pools).flatMap(pool => pool.teams).find(item => item.id === id);
  assert.deepEqual([team('c2').level, team('c2').registeredLevel], ['C', 'B'], 'bracket level still comes from the pool');
  assert.deepEqual([team('c1').level, team('c1').registeredLevel], ['C', 'C']);
});

test('a record refresh keeps the saved GameChanger location; setting the link captures it', async () => {
  const scope = { teamKey:'gc-loc', seasonKey:'fall-2026', eventKey:'classic' };
  const links = { opp:'https://web.gc.com/teams/ABC123' };
  const profile = city => async () => Response.json({ id:'ABC123', location:{ city, state:'CA' },
    team_season:{ record:{ win:1, loss:0, tie:0 } } });
  await refreshGameChangerRecords(scope, links, { updateLocation:true, fetchImpl:profile('Example City A') });
  await refreshGameChangerRecords(scope, links, { fetchImpl:profile('Example City E') });
  assert.deepEqual((await readGameChangerRecords(scope)).opp.location, { city:'Example City A', state:'CA' });
  await refreshGameChangerRecords(scope, links, { updateLocation:true, fetchImpl:profile('Example City E') });
  assert.deepEqual((await readGameChangerRecords(scope)).opp.location, { city:'Example City E', state:'CA' });
});

test('saveOpponent stores overrides and the link in one write, and the snapshot serves the result', async (t) => {
  const teamKey = 'opp-team', seasonKey = 'fall-2026', eventKey = 'classic';
  const scope = { teamKey, seasonKey, eventKey };
  await writeCatalog({ defaultTeamKey:teamKey, teams:{
    [teamKey]:{ key:teamKey, name:'Opp Team', defaultSeasonKey:seasonKey,
      seasons:{ [seasonKey]:{ key:seasonKey, name:'Fall 2026', status:'active' } } },
  } });
  await writeTeam({ key:teamKey, name:'Opp Team', agePrefix:'10U', defaultSeasonKey:seasonKey });
  await writeSeason({ teamKey, key:seasonKey, name:'Fall 2026', status:'active', teamConfig:{},
    featuredEventKey:eventKey, events:{ [eventKey]:{ key:eventKey, providerRef:'123', config:{} } } });
  await writeStructure('123', { meta:{ eventId:'123', name:'Classic', providerTeamId:'mine', dates:['2026-09-25'] }, poolOrder:['A'],
    pools:{ A:{ teams:[{ id:'mine', name:'Ours' }, { id:'opp', name:'Example Club B 10U - Provider Coach', city:'Example City B', state:'CA' },
      { id:'two', name:'Example Club A 10B' }],
      games:[{ key:'g1', time:'2026-09-25T09:00:00', hid:'mine', hn:'Ours', aid:'opp', an:'Example Club B 10U - Provider Coach' }] } }, brackets:[] }, scope);
  await writeResults('123', { games:{ g1:{ topScore:5, botScore:1, status:'completed' } }, standings:{}, bracketGames:{} }, scope);
  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=test-admin-secret', { method:'POST',
      headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ...scope, ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  const publicSnap = async () => (await snapshot(new Request(`http://localhost/api/snapshot?team=${teamKey}&season=${seasonKey}`))).json();
  const config = async () => (await readSeason(teamKey, seasonKey)).events[eventKey].config;

  assert.equal((await post({ action:'saveOpponent', teamId:'missing', fields:{ name:'X' } })).status, 400);
  assert.equal((await post({ action:'saveOpponent', teamId:'opp', fields:{ state:'Calif' } })).status, 400);
  assert.equal((await post({ action:'saveOpponent', teamId:'opp', fields:{ gcUrl:'https://evil.example/teams/ABC123' } })).status, 400);
  assert.equal((await post({ action:'saveOpponent', teamId:'opp', fields:{} })).status, 400);
  assert.deepEqual(await config(), {}, 'a rejected save writes nothing');

  t.mock.method(globalThis, 'fetch', async target => {
    assert.match(String(target), /\/public\/teams\/ABC123$/);
    return Response.json({ id:'ABC123', location:{ city:'Example City C', state:'CA' }, team_season:{ record:{ win:4, loss:2, tie:0 } } });
  });
  const saved = await post({ action:'saveOpponent', teamId:'opp',
    fields:{ name:'Example Club', coach:'Edited Coach', state:'nv', gcUrl:'https://web.gc.com/teams/ABC123', gcName:'Example Club 10U Edited Coach' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.deepEqual(saved.body.opponent, { name:'Example Club', coach:'Edited Coach', state:'NV' });
  assert.equal(saved.body.url, 'https://web.gc.com/teams/ABC123');
  assert.deepEqual((await config()).opponents, { opp:{ name:'Example Club', coach:'Edited Coach', state:'NV' } });
  assert.equal((await config()).gameChangerTeamNames.opp, 'Example Club 10U Edited Coach');

  const row = (await post({ action:'getState' })).body.opponents.find(item => item.teamId === 'opp');
  assert.deepEqual([row.name, row.coach, row.city, row.state], ['Example Club', 'Edited Coach', 'Example City B', 'NV']);
  assert.deepEqual(row.defaults, { name:'Example Club B 10U', coach:'Provider Coach', city:'Example City B', state:'CA' });

  const snap = await publicSnap();
  assert.equal(snap.pools.A.games[0].an, 'Example Club - Edited Coach');
  assert.equal(snap.pools.A.teams[1].name, 'Example Club - Edited Coach');
  assert.deepEqual(snap.config.teamDisplay.opp,
    { name:'Example Club', coach:'Edited Coach', city:'Example City B', state:'NV', providerName:'Example Club B 10U - Provider Coach' });
  assert.equal(snap.config.opponents, undefined);
  // Recent Results use the edited name for this tournament's game too.
  assert.deepEqual(snap.wicked.games.map(game => [game.opp, game.score]), [['Example Club - Edited Coach', '5-1']]);
  assert.deepEqual(snap.config.gameChangerRecords.opp, { win:4, loss:2, tie:0 });

  // The other opponent has no provider location, so its linked GameChanger profile supplies one.
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ id:'XYZ789', location:{ city:'Example City I', state:'CA' }, team_season:{ record:{ win:1, loss:1, tie:0 } } }));
  assert.equal((await post({ action:'saveOpponent', teamId:'two', fields:{ gcUrl:'https://web.gc.com/teams/XYZ789' } })).status, 200);
  assert.deepEqual((await publicSnap()).config.teamDisplay.two,
    { name:'Example Club A 10B', coach:'', city:'Example City I', state:'CA', providerName:'Example Club A 10B' });

  // Blank falls back to the provider's value; removing the link keeps the other edits.
  const cleared = await post({ action:'saveOpponent', teamId:'opp', fields:{ name:'', state:'', gcUrl:'' } });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await config()).opponents.opp, { coach:'Edited Coach' });
  assert.equal((await config()).gameChangerTeams.opp, null);
  const after = await publicSnap();
  assert.equal(after.pools.A.games[0].an, 'Example Club B 10U - Edited Coach');
  assert.deepEqual([after.config.teamDisplay.opp.name, after.config.teamDisplay.opp.state], ['Example Club B 10U', 'CA']);
});

test('auto-detect keeps a season change saved while its searches were running', async (t) => {
  const teamKey = 'opp-race', seasonKey = 'fall-2026', eventKey = 'classic';
  const scope = { teamKey, seasonKey, eventKey };
  await writeCatalog({ defaultTeamKey:teamKey, teams:{
    [teamKey]:{ key:teamKey, name:'Race Team', defaultSeasonKey:seasonKey,
      seasons:{ [seasonKey]:{ key:seasonKey, name:'Fall 2026', status:'active' } } },
  } });
  await writeTeam({ key:teamKey, name:'Race Team', agePrefix:'10U', defaultSeasonKey:seasonKey });
  await writeSeason({ teamKey, key:seasonKey, name:'Fall 2026', status:'active', teamConfig:{},
    featuredEventKey:eventKey, events:{ [eventKey]:{ key:eventKey, providerRef:'123',
      config:{ opponents:{ opp:{ state:'NV' } } } } } });
  await writeStructure('123', { meta:{ providerTeamId:'mine', dates:['2026-09-25'] }, poolOrder:['A'],
    pools:{ A:{ teams:[{ id:'mine', name:'Ours' }, { id:'opp', name:'Opponent' }], games:[] } }, brackets:[] }, scope);
  let searched;
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    if (String(target).includes('/public/teams/'))
      return Response.json({ id:'ABC123', team_season:{ record:{ win:1, loss:0, tie:0 } } });
    searched = JSON.parse(init.body);
    // Another save lands on the season record while the search is still in flight.
    const season = await readSeason(teamKey, seasonKey);
    season.teamConfig = { snacksUrl:'https://example.com/snacks' };
    season.events[eventKey].config.rulesUrl = 'https://example.com/rules.pdf';
    await writeSeason(season);
    return Response.json({ hits:[{ type:'team', result:{ public_id:'ABC123', name:'Opponent 10U',
      season:{ name:'Fall', year:2026 }, location:{ city:'Example City F', state:'NV' } } }] });
  });
  const response = await admin(new Request('http://localhost/admin?key=test-admin-secret', { method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ ...scope, action:'autoFindGameChangerTeams', gcToken:'entered-token' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).matched.length, 1);
  assert.deepEqual(searched.states, ['NV'], 'the overridden state is searched');
  const season = await readSeason(teamKey, seasonKey);
  assert.equal(season.teamConfig.snacksUrl, 'https://example.com/snacks');
  assert.equal(season.events[eventKey].config.rulesUrl, 'https://example.com/rules.pdf');
  assert.equal(season.events[eventKey].config.gameChangerTeams.opp, 'https://web.gc.com/teams/ABC123');
});
