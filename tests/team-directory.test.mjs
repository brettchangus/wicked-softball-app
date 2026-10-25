import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';
const stores = installMemoryBlobStore();
const { matchDirectory, normalizeDirectoryEntry, seedTeamDirectory, directoryPeriod } =
  await import('../netlify/functions/lib/team-directory.js');
const { writeCatalog, writeTeam, writeSeason, writeStructure, readDirectoryEntries, readDirectoryEntry,
  writeDirectoryEntry, readSeason } = await import('../netlify/functions/lib/snapshot.js');
const admin = (await import('../netlify/functions/admin.js')).default;
const snapshot = (await import('../netlify/functions/snapshot.js')).default;
process.env.ADMIN_SECRET = 'directory-test';
const gc = 'https://web.gc.com/teams/ohana';
const context = { team:{ agePrefix:'10U' }, season:{ key:'fall-2026', name:'Fall 2026' }, event:{ config:{} } };
const structure = { meta:{ provider:'tourneymachine', eventId:'tm-one', dates:['2026-11-07'],
  ast:{ teams:['Ohana Warriors-Sparks/Oelhafen'] } },
  pools:{ A:{ teams:[{ id:'ohana-id', name:'Ohana Warriors 10u' }] } }, brackets:[] };
const entry = { id:'ohana', name:'Ohana Warriors', age:10, aliases:['Ohana Warriors-Sparks/Oelhafen'],
  profiles:{ '2026-fall':gc }, identities:[] };

test('directory matches AST name variations and normalized names across providers in the same season', () => {
  const result = matchDirectory(context, structure, [entry]);
  assert.equal(result.links['ohana-id'], gc);
  assert.equal(result.matches['ohana-id'].basis, 'alias');
  const norcal = { ...structure, meta:{ provider:'norcal', dates:['2026-11-07'] },
    pools:{ A:{ teams:[{ id:'123', name:'Ohana Warriors 10U - Sparks/Oelhafen' }] } } };
  assert.equal(matchDirectory(context, norcal, [entry]).links['123'], gc);
});

test('matching rejects conflicting identities, ambiguous names, ages, and other seasonal profiles', () => {
  assert.equal(matchDirectory(context, structure, [entry, { ...entry, id:'other' }]).links['ohana-id'], undefined);
  assert.equal(matchDirectory(context, structure, [{ ...entry, age:12 }]).links['ohana-id'], undefined);
  assert.equal(matchDirectory(context, structure, [{ ...entry, profiles:{ '2026-summer':gc } }]).links['ohana-id'], null);
  const withId = { ...entry, aliases:[], identities:['tm:tm-one:ohana-id'] };
  assert.equal(matchDirectory(context, structure, [withId]).matches['ohana-id'].basis, 'provider');
  const otherEvent = { ...structure, meta:{ ...structure.meta, eventId:'tm-two' } };
  assert.equal(matchDirectory(context, otherEvent, [withId]).links['ohana-id'], undefined);
  assert.equal(matchDirectory(context, structure, [withId, { ...withId, id:'other' }]).links['ohana-id'], undefined);
});

test('known provider identities without a current profile cannot fall back to another team', () => {
  const norcal = { meta:{ provider:'norcal', division:'10U', dates:['2026-11-07'] },
    pools:{ A:{ teams:[{ id:'123', name:'OutKasts' }] } } };
  const teams = [{ id:'known', name:'OutKasts', age:10, aliases:['OutKasts'], identities:['norcal:123'],
    profiles:{ '2026-summer':gc } },
    { id:'different', name:'OutKasts', age:10, aliases:['OutKasts'], identities:['norcal:999'],
      profiles:{ '2026-fall':'https://web.gc.com/teams/different' } }];
  const result = matchDirectory(context, norcal, teams);
  assert.equal(result.matches['123'].entryId, 'known');
  assert.equal(result.matches['123'].basis, 'provider');
  assert.equal(result.links['123'], null);
});

test('a shared alias stays ambiguous when one team has no current-season profile', () => {
  const result = matchDirectory(context, structure, [entry,
    { ...entry, id:'other', profiles:{ '2026-summer':gc } }]);
  assert.equal(result.matches['ohana-id'].basis, 'ambiguous');
  assert.equal(result.links['ohana-id'], undefined);
});

test('directory matching uses tournament selection and division age before the team fallback', () => {
  const teams = [10,12,14].map(age => ({ id:'stars-' + age, name:'Stars-Jones', age, coach:'Jones',
    aliases:['Stars-Jones'], identities:[], profiles:{ '2026-fall':'https://web.gc.com/teams/stars' + age } }));
  const tournament = { meta:{ provider:'tourneymachine', dates:['2026-11-07'], division:'12U' },
    pools:{ A:{ teams:[{ id:'stars', name:'Stars-Jones' }] } } };
  const selected = { ...context, event:{ config:{}, discovery:{ detected:{ age:10 }, manual:{ age:12 } } } };
  assert.equal(matchDirectory(selected, { ...tournament, meta:{ ...tournament.meta, division:'10U' } }, teams).links.stars,
    'https://web.gc.com/teams/stars12');
  assert.equal(matchDirectory(context, tournament, teams).links.stars, 'https://web.gc.com/teams/stars12');
  assert.equal(matchDirectory(context, { ...tournament, meta:{ ...tournament.meta, division:'', ast:{ divisionLabel:'12U' } } }, teams).links.stars,
    'https://web.gc.com/teams/stars12');
  assert.equal(matchDirectory(context, { ...tournament, meta:{ ...tournament.meta, division:'' } }, teams).links.stars,
    'https://web.gc.com/teams/stars10');
  const explicit = { ...tournament, pools:{ A:{ teams:[{ id:'stars', name:'Stars 14U-Jones' }] } } };
  assert.equal(matchDirectory(selected, explicit, teams).links.stars, 'https://web.gc.com/teams/stars14');
});

test('a broad known alias cannot override a conflicting coach in the AST registration list', () => {
  const changed = { ...structure, meta:{ ...structure.meta, ast:{ teams:['Ohana Warriors-Lee'] } } };
  const broad = { ...entry, coach:'Sparks/Oelhafen', aliases:['Ohana Warriors'] };
  assert.equal(matchDirectory(context, changed, [broad]).links['ohana-id'], undefined);
  assert.equal(matchDirectory(context, structure, [broad]).links['ohana-id'], gc);
});

test('explicit tournament links and clears win; selected directory matches replace wrong local links', () => {
  assert.equal(matchDirectory(context, structure, [entry], { 'ohana-id':null }).links['ohana-id'], null);
  assert.equal(matchDirectory(context, structure, [entry], { 'name:ohanawarriorssparksoelhafen':null }).links['ohana-id'], null);
  assert.equal(matchDirectory(context, structure, [entry], { 'ohana-id':'manual' }).links['ohana-id'], 'manual');
  const selected = { ...context, event:{ config:{ directoryMatches:{ 'ohana-id':{ entryId:'ohana' } } } } };
  assert.equal(matchDirectory(selected, structure, [entry], { 'ohana-id':'wrong' }).links['ohana-id'], gc);
  selected.event.config.directoryMatches['ohana-id'] = { entryId:null };
  assert.equal(matchDirectory(selected, structure, [entry], { 'ohana-id':'wrong' }).links['ohana-id'], null);
});

test('confirmed pending assignments and explicit overrides survive schedule publication', () => {
  const pendingKey = 'name:ohanawarriorssparksoelhafen';
  const selected = { ...context, event:{ config:{ directoryMatches:{ [pendingKey]:{ entryId:'ohana' } } } } };
  assert.equal(matchDirectory(selected, structure, [entry]).links['ohana-id'], gc);
  selected.event.config.directoryMatches['ohana-id'] = { override:true };
  assert.equal(matchDirectory(selected, structure, [entry], { 'ohana-id':null }).links['ohana-id'], null);
});

test('calendar profile seasons honor the configured season for August fall tournaments', () => {
  assert.equal(directoryPeriod(context, { meta:{ dates:['2026-08-29'] } }), '2026-fall');
  assert.equal(directoryPeriod({}, {}), null);
});

test('directory updates validate URLs and preserve identity and historical profiles', () => {
  const result = normalizeDirectoryEntry({ name:'Ohana', aliases:['Ohana', 'Ohana'], period:'2027-spring', url:gc }, entry);
  assert.equal(result.id, entry.id);
  assert.deepEqual(result.aliases, ['Ohana']);
  assert.deepEqual(result.profiles, { '2026-fall':gc, '2027-spring':gc });
  assert.throws(() => normalizeDirectoryEntry({ name:'x', period:'2026-fall', url:'https://evil.example/teams/x' }));
  assert.throws(() => normalizeDirectoryEntry({ name:'' }));
});

async function seedFixture() {
  for (const store of stores.values()) store.clear();
  const catalog = { defaultTeamKey:'ours', teams:{ ours:{ key:'ours', defaultSeasonKey:'fall-2026',
    seasons:{ 'fall-2026':{ key:'fall-2026', name:'Fall 2026', status:'active' } } } } };
  await writeCatalog(catalog);
  await writeTeam({ key:'ours', name:'Our Team', agePrefix:'10U', defaultSeasonKey:'fall-2026' });
  const events = {
    pending:{ key:'pending', name:'Pending', providerRef:'ast-pending', config:{ gameChangerTeams:{
      'name:ohanawarriorssparksoelhafen':gc } } },
    old:{ key:'old', name:'Old tournament', providerRef:'tm-old', config:{ gameChangerTeams:{ 'old-id':gc } } },
    current:{ key:'current', name:'Current', providerRef:'tm-current', config:{} },
  };
  await writeSeason({ teamKey:'ours', key:'fall-2026', name:'Fall 2026', status:'active', featuredEventKey:'current', events });
  const scope = eventKey => ({ teamKey:'ours', seasonKey:'fall-2026', eventKey });
  await writeStructure('ast-pending', { meta:{ schedulePending:true, dates:['2026-10-10'],
    ast:{ teams:['Ohana Warriors-Sparks/Oelhafen'] } } }, scope('pending'));
  await writeStructure('tm-old', { meta:{ provider:'tourneymachine', eventId:'tm-old', dates:['2026-10-17'] },
    pools:{ A:{ teams:[{ id:'old-id', name:'Ohana Warriors 10u' }] } } }, scope('old'));
  await writeStructure('tm-current', structure, scope('current'));
  return { catalog };
}

test('seeding imports all saved tournaments, groups profile aliases, and is idempotent', async () => {
  const { catalog } = await seedFixture();
  const imported = await seedTeamDirectory(catalog);
  assert.equal(imported.imported, 1);
  const [seeded] = await readDirectoryEntries();
  assert.deepEqual(new Set(seeded.aliases), new Set(['Ohana Warriors-Sparks/Oelhafen', 'Ohana Warriors 10u']));
  assert.ok(seeded.identities.includes('tm:tm-old:old-id'));
  seeded.name = 'Admin corrected name'; await writeDirectoryEntry(seeded);
  assert.equal((await seedTeamDirectory(catalog, { force:true })).imported, 0);
  assert.equal((await readDirectoryEntries())[0].name, 'Admin corrected name');
  const response = await snapshot(new Request('http://localhost/api/snapshot?team=ours&season=fall-2026'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.gameChangerTeams['ohana-id'], gc);
});

async function singleSeedFixture(config, tournament, discovery = null) {
  const { catalog } = await seedFixture();
  const season = await readSeason('ours', 'fall-2026');
  season.events = { current:{ key:'current', name:'Current', providerRef:'tm-current', config, discovery } };
  await writeSeason(season);
  await writeStructure('tm-current', tournament, { teamKey:'ours', seasonKey:'fall-2026', eventKey:'current' });
  return catalog;
}

const apexSchedule = { meta:{ provider:'tourneymachine', eventId:'tm-current', division:'10U', dates:['2026-11-07'],
  ast:{ teams:['Apex-Webber', 'Hollister Heat-Cintron'] } },
  pools:{ A:{ teams:[{ id:'apex-id', name:'Apex Webber 10U' }] } }, brackets:[] };

test('seeding imports the corrected published link and keeps its aliases, without reviving the old URL', async () => {
  const corrected = 'https://web.gc.com/teams/corrected';
  const catalog = await singleSeedFixture({ gameChangerTeams:{ 'name:apexwebber':'https://web.gc.com/teams/outdated',
    'apex-id':corrected, 'name:hollisterheatcintron':'https://web.gc.com/teams/hollister' } }, apexSchedule);
  assert.equal((await seedTeamDirectory(catalog)).imported, 2);
  const teams = await readDirectoryEntries();
  assert.ok(!teams.some(row => row.profiles['2026-fall'].endsWith('/outdated')));
  const apex = teams.find(row => row.profiles['2026-fall'] === corrected);
  assert.deepEqual(new Set(apex.aliases), new Set(['Apex-Webber', 'Apex Webber 10U']));
  assert.ok(apex.identities.includes('tm:tm-current:apex-id'));
  assert.ok(teams.some(row => row.aliases.includes('Hollister Heat-Cintron')));
  const future = { ...apexSchedule, meta:{ ...apexSchedule.meta, eventId:'next' },
    pools:{ A:{ teams:[{ id:'new-apex-id', name:'Apex Webber 10U' }] } } };
  assert.equal(matchDirectory(context, future, teams).links['new-apex-id'], corrected);
  assert.equal((await seedTeamDirectory(catalog, { force:true })).imported, 0);
});

test('seeding does not revive a name-keyed link cleared on the published team', async () => {
  const catalog = await singleSeedFixture({ gameChangerTeams:{ 'name:apexwebber':'https://web.gc.com/teams/outdated',
    'apex-id':null } }, apexSchedule);
  assert.equal((await seedTeamDirectory(catalog)).imported, 0);
  assert.deepEqual(await readDirectoryEntries(), []);
});

test('seeding uses an explicit directory correction instead of an older tournament URL', async () => {
  const catalog = await singleSeedFixture({ gameChangerTeams:{ 'name:apexwebber':'https://web.gc.com/teams/outdated' },
    directoryMatches:{ 'apex-id':{ entryId:'correct-team' } } }, apexSchedule);
  const correct = { id:'correct-team', name:'Apex-Webber', age:10, aliases:['Apex-Webber'], identities:[],
    profiles:{ '2026-fall':'https://web.gc.com/teams/correct' } };
  await writeDirectoryEntry(correct);
  assert.equal((await seedTeamDirectory(catalog)).imported, 0);
  assert.deepEqual(await readDirectoryEntries(), [correct]);
});

test('seeded and newly remembered teams inherit the selected playing-up age', async () => {
  const tournament = { meta:{ provider:'tourneymachine', eventId:'tm-current', division:'12U', dates:['2026-11-07'] },
    pools:{ A:{ teams:[{ id:'stars', name:'Stars-Jones' }] } }, brackets:[] };
  const catalog = await singleSeedFixture({ gameChangerTeams:{ stars:gc } }, tournament,
    { manual:{ age:12 } });
  await seedTeamDirectory(catalog);
  assert.equal((await readDirectoryEntries())[0].age, 12);
  const { rememberDirectoryLink } = await import('../netlify/functions/lib/team-directory.js');
  await rememberDirectoryLink({ ...context, event:{ discovery:{ manual:{ age:14 } } } }, tournament,
    'stars', 'https://web.gc.com/teams/stars14');
  assert.equal((await readDirectoryEntries()).find(row => row.profiles['2026-fall'].endsWith('/stars14')).age, 14);
});

test('admin can create a separate directory team from a wrong match, unmatch, and edit profiles', async () => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=directory-test', { method:'POST',
      body:JSON.stringify({ teamKey:'ours', seasonKey:'fall-2026', eventKey:'current', ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  assert.equal((await admin(new Request('http://localhost/admin?key=wrong', { method:'POST', body:'{}' }))).status, 403);
  const [old] = await readDirectoryEntries();
  const result = await post({ action:'matchDirectoryTeam', mode:'create', teamId:'ohana-id',
    entry:{ name:'Separate Ohana Team', age:10, aliases:[], url:'https://web.gc.com/teams/separate' } });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.entry.id, old.id);
  assert.deepEqual(await readDirectoryEntry(old.id), old);
  const state = await post({ action:'getState' });
  assert.equal(state.body.config.events['tm-current'].gameChangerTeams['ohana-id'], 'https://web.gc.com/teams/separate');
  assert.equal(state.body.directoryMatches['ohana-id'].basis, 'confirmed');
  const snap = await (await snapshot(new Request('http://localhost/api/snapshot?team=ours&season=fall-2026'))).json();
  assert.equal(snap.config.gameChangerTeams['ohana-id'], 'https://web.gc.com/teams/separate');
  assert.equal((await post({ action:'matchDirectoryTeam', mode:'existing', teamId:'missing', entryId:old.id })).status, 400);
  assert.equal((await post({ action:'matchDirectoryTeam', mode:'unmatched', teamId:'ohana-id' })).status, 200);
  const unmatched = await post({ action:'getState' });
  assert.equal(unmatched.body.config.events['tm-current'].gameChangerTeams['ohana-id'], null);
  const detect = await post({ action:'autoFindGameChangerTeams', gcToken:'unused' });
  assert.equal(detect.status, 200);
  assert.deepEqual(detect.body.matched, []);
  assert.equal((await post({ action:'getState' })).body.config.events['tm-current'].gameChangerTeams['ohana-id'], null);
  const stored = await readSeason('ours', 'fall-2026');
  assert.equal(stored.events.current.config.directoryMatches['ohana-id'].entryId, null);
  assert.equal((await post({ action:'saveDirectoryTeam', entryId:old.id,
    entry:{ name:old.name, aliases:old.aliases, period:'2027-spring', url:gc } })).status, 200);
  assert.equal((await readDirectoryEntry(old.id)).profiles['2026-fall'], gc);
  assert.equal((await post({ action:'saveDirectoryTeam', entry:{ name:'Bad', period:'2026-fall', url:'http://gc.com/no' } })).status, 400);
});

test('editing a linked opponent updates shared directory fields and keeps class scoped to its tournament', async () => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [original] = await readDirectoryEntries();
  const season = await readSeason('ours', 'fall-2026');
  season.events.current.config.opponents = { 'ohana-id':{ name:'Old local name', coach:'Old coach', level:'C' } };
  season.events.old.config.opponents = { 'old-id':{ name:'Another local name' } };
  await writeSeason(season);
  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=directory-test', { method:'POST',
      body:JSON.stringify({ teamKey:'ours', seasonKey:'fall-2026', eventKey:'current', ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  const draft = { name:'Ohana Club', coach:'Lee', city:'Dixon', state:'CA', age:10,
    aliases:original.aliases, period:'2026-fall', url:gc };
  assert.equal((await post({ action:'saveDirectoryTeam', entryId:original.id, teamId:'ohana-id', entry:draft, level:'B' })).status, 200);
  const saved = await readDirectoryEntry(original.id);
  assert.deepEqual([saved.name, saved.coach, saved.city], ['Ohana Club', 'Lee', 'Dixon']);
  assert.equal(saved.level, undefined);
  const state = (await post({ action:'getState' })).body;
  const row = state.opponents.find(team => team.teamId === 'ohana-id');
  assert.deepEqual([row.name, row.coach, row.city, row.level], ['Ohana Club', 'Lee', 'Dixon', 'B']);
  assert.deepEqual(row.override, { level:'B' }, 'ignored tournament identity overrides are not exposed as active edits');
  assert.equal((await readSeason('ours', 'fall-2026')).events.current.config.opponents['ohana-id'].name, 'Old local name');
  const other = (await post({ action:'getState', eventKey:'old' })).body.opponents.find(team => team.teamId === 'old-id');
  assert.deepEqual([other.name, other.coach, other.city, other.level], ['Ohana Club', 'Lee', 'Dixon', '']);
  const publicSnap = await (await snapshot(new Request('http://localhost/api/snapshot?team=ours&season=fall-2026'))).json();
  assert.equal(publicSnap.pools.A.teams[0].name, 'Ohana Club - Lee');
  assert.equal(publicSnap.config.teamDisplay['ohana-id'].providerName, 'Ohana Warriors 10u');
  assert.equal((await readSeason('ours', 'fall-2026')).events.current.config.directoryMatches['ohana-id'].entryId, original.id);

  // A new seasonal URL must keep the current tournament attached to the same directory team.
  const replacement = 'https://web.gc.com/teams/replacement';
  assert.equal((await post({ action:'saveDirectoryTeam', entryId:original.id, teamId:'ohana-id',
    entry:{ ...draft, url:replacement }, level:'' })).status, 200);
  const refreshed = (await post({ action:'getState' })).body;
  assert.equal(refreshed.config.events['tm-current'].gameChangerTeams['ohana-id'], replacement);
  assert.equal(refreshed.opponents.find(team => team.teamId === 'ohana-id').level, '');

  assert.equal((await post({ action:'saveDirectoryTeam', entryId:original.id, teamId:'missing',
    entry:{ ...draft, name:'Do not save' } })).status, 409);
  assert.equal((await readDirectoryEntry(original.id)).name, 'Ohana Club');
  assert.equal((await post({ action:'saveDirectoryTeam', entryId:original.id, teamId:'ohana-id',
    entry:draft, level:'invalid' })).status, 400);
});

test('deleting a directory team clears explicit and inferred matches without deleting tournament data', async () => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [entry] = await readDirectoryEntries();
  const season = await readSeason('ours', 'fall-2026');
  season.events.current.config.directoryMatches = { 'ohana-id':{ entryId:entry.id } };
  season.events.current.config.opponents = { 'ohana-id':{ level:'C' } };
  await writeSeason(season);
  const { readStructure } = await import('../netlify/functions/lib/snapshot.js');
  const scope = { teamKey:'ours', seasonKey:'fall-2026', eventKey:'current' };
  const before = await readStructure('tm-current', scope);
  const post = async body => {
    const response = await admin(new Request('http://localhost/admin?key=directory-test', { method:'POST',
      body:JSON.stringify({ ...scope, ...body }) }));
    return { status:response.status, body:await response.json() };
  };
  const deleted = await post({ action:'deleteDirectoryTeam', entryId:entry.id });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.body.unlinked >= 3);
  assert.deepEqual(deleted.body.entries, []);
  assert.equal(await readDirectoryEntry(entry.id), null);
  assert.deepEqual(await readDirectoryEntries(), []);
  const tombstone = await readDirectoryEntry(entry.id, { includeDeleted:true });
  assert.ok(tombstone.deletedAt);
  assert.deepEqual(tombstone.profiles, entry.profiles);
  const latest = await readSeason('ours', 'fall-2026');
  assert.equal(latest.events.current.config.directoryMatches['ohana-id'].entryId, null);
  assert.equal(latest.events.old.config.directoryMatches['old-id'].entryId, null);
  assert.equal(latest.events.pending.config.directoryMatches['name:ohanawarriorssparksoelhafen'].entryId, null);
  assert.equal(latest.events.current.config.opponents['ohana-id'].level, 'C');
  assert.deepEqual(await readStructure('tm-current', scope), before);
  const state = (await post({ action:'getState' })).body;
  assert.equal(state.config.events['tm-current'].gameChangerTeams['ohana-id'], null);
  assert.equal((await seedTeamDirectory(catalog, { force:true })).imported, 0);
  assert.deepEqual(await readDirectoryEntries(), []);
  assert.equal((await post({ action:'saveDirectoryTeam', entryId:entry.id, entry:{ name:'Restore silently' } })).status, 404);
  assert.equal((await post({ action:'matchDirectoryTeam', mode:'existing', teamId:'ohana-id', entryId:entry.id })).status, 404);
  assert.equal((await post({ action:'deleteDirectoryTeam', entryId:entry.id })).status, 404);
});

test('directory deletion preserves direct and pending-name tournament link overrides', async () => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [entry] = await readDirectoryEntries();
  const season = await readSeason('ours', 'fall-2026');
  season.events.old.config.directoryMatches = { 'old-id':{ override:true } };
  season.events.current.config.gameChangerTeams = { 'ohana-id':gc };
  const pendingKey = 'name:ohanawarriorssparksoelhafen';
  season.events.current.config.directoryMatches = { [pendingKey]:{ override:true } };
  await writeSeason(season);
  const { deleteDirectoryTeam, loadDirectoryMatches } = await import('../netlify/functions/lib/team-directory.js');
  await deleteDirectoryTeam(entry);
  const latest = await readSeason('ours', 'fall-2026');
  assert.deepEqual(latest.events.old.config.directoryMatches, { 'old-id':{ override:true } });
  assert.deepEqual(latest.events.current.config.directoryMatches, { [pendingKey]:{ override:true } });
  const result = await loadDirectoryMatches({ ...context, season:latest, event:latest.events.current }, structure);
  assert.equal(result.links['ohana-id'], gc);
});

test('deletion rereads and preserves an override saved while its scan was running', async t => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [entry] = await readDirectoryEntries();
  const season = await readSeason('ours', 'fall-2026');
  season.events.current.config.gameChangerTeams = { 'ohana-id':gc };
  await writeSeason(season);
  const data = stores.get('tournament'), get = data.get.bind(data);
  let changed = false;
  t.mock.method(data, 'get', key => {
    const value = get(key);
    if (!changed && key === 'v2:ours:fall-2026:current:structure') {
      changed = true;
      const fresh = JSON.parse(get('v2:season:ours:fall-2026'));
      fresh.events.current.config.directoryMatches = { 'name:ohanawarriorssparksoelhafen':{ override:true } };
      data.set('v2:season:ours:fall-2026', JSON.stringify(fresh));
    }
    return value;
  });
  const { deleteDirectoryTeam } = await import('../netlify/functions/lib/team-directory.js');
  await deleteDirectoryTeam(entry);
  assert.equal(changed, true);
  const latest = await readSeason('ours', 'fall-2026');
  assert.deepEqual(latest.events.current.config.directoryMatches,
    { 'name:ohanawarriorssparksoelhafen':{ override:true } });
});

test('history labels reuse one directory read and skip records for tournaments without matches or edits', async () => {
  await seedFixture();
  await writeDirectoryEntry({ ...entry, name:'Ohana Club', coach:'Lee', aliases:['Ohana Warriors 10u'], identities:['tm:tm-one:ohana-id'] });
  const { loadHistoryTeamLabels } = await import('../netlify/functions/lib/team-display.js');
  const events = { linked:{ key:'linked', config:{} }, empty:{ key:'empty', config:{} },
    edited:{ key:'edited', config:{ opponents:{ plain:{ name:'Edited team' } } } } };
  const plain = { meta:{ eventId:'plain', dates:['2026-11-07'] }, pools:{ A:{ teams:[{ id:'plain', name:'Different team' }] } } };
  const before = stores.operations.length;
  const labels = await loadHistoryTeamLabels({ ...context, teamKey:'ours', seasonKey:'fall-2026', eventKey:'current' },
    events, events, key => key === 'linked' ? structure : { ...plain, meta:{ ...plain.meta, eventId:key } });
  const operations = stores.operations.slice(before);
  assert.equal(operations.filter(row => row.operation === 'list' && row.prefix === 'v2:directory:team:').length, 1);
  assert.equal(operations.filter(row => row.operation === 'get' && row.key.endsWith(':gameChangerRecords')).length, 2);
  assert.equal(labels['tm-one']['ohana-id'], 'Ohana Club - Lee');
  assert.equal(labels.empty, undefined);
  assert.equal(labels.edited.plain, 'Edited team');
  const beforeRequest = stores.operations.length;
  assert.equal((await snapshot(new Request('http://localhost/api/snapshot?team=ours&season=fall-2026'))).status, 200);
  assert.equal(stores.operations.slice(beforeRequest)
    .filter(row => row.operation === 'list' && row.prefix === 'v2:directory:team:').length, 1);
});

test('deletion scans all contexts before cleanup and writes each changed season once', async () => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [entry] = await readDirectoryEntries();
  await writeSeason({ teamKey:'ours', key:'second', name:'Fall 2026', status:'active', events:{
    extra:{ key:'extra', providerRef:'extra', config:{ gameChangerTeams:{ 'ohana-id':gc } } },
  } });
  await writeStructure('extra', structure, { teamKey:'ours', seasonKey:'second', eventKey:'extra' });
  const before = stores.operations.length;
  const { deleteDirectoryTeam } = await import('../netlify/functions/lib/team-directory.js');
  await deleteDirectoryTeam(entry);
  const operations = stores.operations.slice(before);
  const firstWrite = operations.findIndex(row => row.operation === 'set' && row.key.startsWith('v2:season:'));
  const lastScan = operations.findLastIndex(row => row.operation === 'get' && row.key.endsWith(':structure'));
  assert.ok(lastScan >= 0 && lastScan < firstWrite);
  for (const key of ['v2:season:ours:fall-2026', 'v2:season:ours:second'])
    assert.equal(operations.filter(row => row.operation === 'set' && row.key === key).length, 1);
});

test('a deleted-team marker hides only the link it cleared and lets a live entry automatch', () => {
  const marker = { 'ohana-id':{ entryId:null, deletedEntryId:'gone', clearedUrl:gc } };
  const cleared = { ...context, event:{ config:{ gameChangerTeams:{ 'ohana-id':gc }, directoryMatches:marker } } };
  assert.equal(matchDirectory(cleared, structure, []).links['ohana-id'], null);
  const replacement = { ...entry, id:'replacement', profiles:{ '2026-fall':'https://web.gc.com/teams/new' } };
  const rematched = matchDirectory(cleared, structure, [replacement]);
  assert.equal(rematched.matches['ohana-id'].entryId, 'replacement');
  assert.equal(rematched.links['ohana-id'], 'https://web.gc.com/teams/new');
  const relinked = { ...context, event:{ config:{ gameChangerTeams:{ 'ohana-id':'https://web.gc.com/teams/saved-later' },
    directoryMatches:marker } } };
  assert.equal(matchDirectory(relinked, structure, []).links['ohana-id'], 'https://web.gc.com/teams/saved-later');
  const pinned = { ...context, event:{ config:{ directoryMatches:{ 'ohana-id':{ entryId:null } } } } };
  assert.equal(matchDirectory(pinned, structure, [replacement]).matches['ohana-id'].entryId, null,
    'an explicit "no match" still wins over automatching');
});

test('deletion keeps the entry and reports a retry when a season write fails', async t => {
  const { catalog } = await seedFixture();
  await seedTeamDirectory(catalog);
  const [entry] = await readDirectoryEntries();
  const data = stores.get('tournament'), set = data.set.bind(data);
  t.mock.method(data, 'set', (key, value) => {
    if (key === 'v2:season:ours:fall-2026') throw new Error('Blob write failed');
    return set(key, value);
  });
  const { deleteDirectoryTeam } = await import('../netlify/functions/lib/team-directory.js');
  await assert.rejects(deleteDirectoryTeam(entry), /could not be updated.*Blob write failed.*delete it again/);
  t.mock.restoreAll();
  assert.ok(await readDirectoryEntry(entry.id), 'the entry is not tombstoned, so Delete can be retried');
  assert.ok((await deleteDirectoryTeam(entry)).unlinked >= 1);
  assert.equal(await readDirectoryEntry(entry.id), null);
});

test('history labels skip loading snapshots when nothing could rename a team', async () => {
  const { loadHistoryTeamLabels } = await import('../netlify/functions/lib/team-display.js');
  const events = { other:{ key:'other', config:{ opponents:{ 'ohana-id':{ level:'C' } } } } };
  let loaded = 0;
  const labels = await loadHistoryTeamLabels({ ...context, teamKey:'ours', seasonKey:'fall-2026', eventKey:'current' },
    events, events, () => { loaded++; return structure; }, { directoryEntries:[] });
  assert.equal(loaded, 0);
  assert.deepEqual(labels, {});
});
