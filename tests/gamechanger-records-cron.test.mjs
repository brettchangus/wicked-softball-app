import { seedTestSite } from './helpers/site-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();
const storage = await import('../netlify/functions/lib/snapshot.js');
const { SETUP_VERSION, MY_ID } = await import('../netlify/functions/lib/tournament.js');
const handler = (await import('../netlify/functions/check-scores.js')).default;

async function activeEvent(eventKey, eventId, config) {
  await seedTestSite();
  const season = await storage.readSeason('team', 'season');
  season.status = 'active'; season.featuredEventKey = eventKey;
  season.events[eventKey] = { key:eventKey, providerRef:eventId, config };
  await storage.writeSeason(season);
  const scope = { teamKey:season.teamKey, seasonKey:season.key, eventKey };
  // A published Tourney Machine schedule more than a week out: no setup, refresh, or score check.
  await storage.writeStructure(eventId, { meta:{ eventId, setupVersion:SETUP_VERSION, norcalTeamId:MY_ID,
    provider:'tourneymachine', dates:['2026-11-07'], bracketDate:'2026-11-08' },
  poolOrder:[], pools:{}, brackets:[] }, scope);
  return scope;
}

test('the score cron refreshes linked GameChanger records on its own schedule', async t => {
  const url = 'https://web.gc.com/teams/example-profile';
  const scope = await activeEvent('gc-cron', 'tm:gc-cron:1', { gameChangerTeams:{ opponent:url } });
  let now = Date.parse('2026-10-17T18:00:00Z'), win = 5;
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async target => {
    calls.push(String(target));
    return Response.json({ id:'example-profile', team_season:{ record:{ win, loss:2, tie:0 } } });
  });
  const tick = async minutes => { now += minutes * 60000; return (await handler()).text(); };

  assert.match(await tick(0), /GameChanger records refreshed \(1 checked, 1 changed, 0 failed\)/);
  assert.deepEqual(calls, ['https://api.team-manager.gc.com/public/teams/example-profile']);
  assert.deepEqual((await storage.readGameChangerRecords(scope)).opponent.record, { win:5, loss:2, tie:0 });
  assert.doesNotMatch(await tick(5), /GameChanger/);
  assert.doesNotMatch(await tick(170), /GameChanger/);
  win = 6;
  assert.match(await tick(5), /GameChanger records refreshed \(1 checked, 1 changed, 0 failed\)/);
  assert.deepEqual((await storage.readGameChangerRecords(scope)).opponent.record, { win:6, loss:2, tie:0 });
  assert.equal(calls.length, 2);

  // Saturday 2026-11-07 (first day) through the Sunday bracket day: every 30 minutes.
  now = Date.parse('2026-11-07T17:00:00Z');
  await storage.writeStructure('tm:gc-cron:1', { ...(await storage.readStructure('tm:gc-cron:1', scope)),
    meta:{ eventId:'tm:gc-cron:1', setupVersion:SETUP_VERSION, norcalTeamId:MY_ID, provider:'manual',
      dates:['2026-11-07'], bracketDate:'2026-11-08' } }, scope);
  t.mock.method(globalThis, 'fetch', async target => {
    calls.push(String(target));
    if (!String(target).includes('team-manager.gc.com')) throw new Error('no provider in this test');
    return Response.json({ id:'example-profile', team_season:{ record:{ win, loss:2, tie:0 } } });
  });
  const gcCalls = () => calls.filter(c => c.includes('team-manager.gc.com')).length;
  await tick(0); assert.equal(gcCalls(), 3);
  await tick(25); assert.equal(gcCalls(), 3);
  await tick(5); assert.equal(gcCalls(), 4);
  now = Date.parse('2026-11-08T17:00:00Z');
  await tick(0); await tick(30); assert.equal(gcCalls(), 6);
});

test('a GameChanger outage keeps the last record and never blocks the rest of the tick', async t => {
  const url = 'https://web.gc.com/teams/example-profile';
  const scope = await activeEvent('gc-outage', 'tm:gc-outage:1', { gameChangerTeams:{ opponent:url } });
  await storage.writeGameChangerRecords(scope, { opponent:{ url, checkedAt:'2026-10-17T00:00:00Z',
    record:{ win:3, loss:1, tie:0 }, location:null, failed:false } });
  t.mock.method(Date, 'now', () => Date.parse('2026-10-17T18:00:00Z'));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  const text = await (await handler()).text();
  assert.match(text, /GameChanger records refreshed \(0 checked, 0 changed, 1 failed\)/);
  assert.match(text, /off-window/);
  const saved = (await storage.readGameChangerRecords(scope)).opponent;
  assert.deepEqual(saved.record, { win:3, loss:1, tie:0 });
  assert.equal(saved.checkedAt, '2026-10-17T18:00:00.000Z');
});

test('a tournament with no GameChanger links makes no requests', async t => {
  const scope = await activeEvent('gc-none', 'tm:gc-none:1', {});
  let calls = 0;
  t.mock.method(Date, 'now', () => Date.parse('2026-10-17T18:00:00Z'));
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected'); });
  assert.doesNotMatch(await (await handler()).text(), /GameChanger/);
  assert.equal(calls, 0);
  assert.deepEqual(await storage.readGameChangerRecords(scope), {});
});

test('the score check does not wait for GameChanger', async t => {
  const url = 'https://web.gc.com/teams/example-profile';
  const eventId = '9990001';
  const scope = await activeEvent('gc-order', eventId, { gameChangerTeams:{ opponent:url } });
  // Today is a tournament day with an unfinished pool game, so the tick also polls that pool.
  await storage.writeStructure(eventId, { meta:{ eventId, setupVersion:SETUP_VERSION, norcalTeamId:MY_ID,
    dates:['2026-11-07'], bracketDate:'2026-11-08' }, poolOrder:['A'], brackets:[],
  pools:{ A:{ roundKey:'round', poolNo:1, teams:[], games:[{ key:'g1' }] } } }, scope);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-07T17:00:00Z'));
  const events = [];
  let releaseGameChanger;
  const gameChangerHeld = new Promise(resolve => { releaseGameChanger = resolve; setTimeout(resolve, 1000); });
  t.mock.method(globalThis, 'fetch', async target => {
    if (String(target).includes('team-manager.gc.com')) {
      events.push('gc start');
      await gameChangerHeld;
      events.push('gc done');
      return Response.json({ id:'example-profile', team_season:{ record:{ win:1, loss:0, tie:0 } } });
    }
    events.push('provider');
    releaseGameChanger();
    throw new Error('provider offline');
  });
  const text = await (await handler()).text();
  // GameChanger is held until the pool is polled (or 1s passes), so the pool poll must not wait for it.
  assert.ok(events.indexOf('provider') >= 0 && events.indexOf('provider') < events.indexOf('gc done'), events.join(', '));
  assert.match(text, /GameChanger records refreshed \(1 checked, 1 changed, 0 failed\)/);
});
