import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();
const { readGameChangerRecords } = await import('../netlify/functions/lib/snapshot.js');
const recordsModule = await import('../netlify/functions/lib/gamechanger-records.js');
const {
  gameChangerPublicId, parseGameChangerRecord, parseGameChangerLocation,
  refreshGameChangerRecords, recordsForGameChangerLinks, locationsForGameChangerLinks, namesForGameChangerLinks,
} = recordsModule;

test('GameChanger records refresh on request and stay scoped to a linked profile', async () => {
  const scope = { teamKey:'gc-record-test', seasonKey:'fall-2026', eventKey:'event' };
  const url = 'https://web.gc.com/teams/example-profile?pid=Copy';
  const links = { opponent:url, invalid:'https://example.com/teams/other' };
  const now = Date.parse('2026-09-25T12:00:00Z');
  const calls = [];
  const fetchImpl = async target => {
    calls.push(String(target));
    return Response.json({ id:'example-profile', name:' Outlaws 10U ', location:{ city:'Benicia', state:'California' },
      team_season:{ record:{ win:5, loss:5, tie:0 } } });
  };
  assert.equal(gameChangerPublicId(url), 'example-profile');
  assert.equal(gameChangerPublicId(links.invalid), null);
  assert.equal(parseGameChangerRecord({ id:'wrong', team_season:{ record:{ win:1, loss:0 } } },
    'example-profile'), null);
  assert.deepEqual(parseGameChangerLocation({ id:'example-profile', location:{ city:'Benicia', state:'California' } },
    'example-profile'), { city:'Benicia', state:'CA' });
  assert.equal(parseGameChangerLocation({ id:'wrong', location:{ city:'Benicia', state:'CA' } },
    'example-profile'), null);
  assert.deepEqual(await refreshGameChangerRecords(scope, links, { now, fetchImpl }),
    { records:{ opponent:{ win:5, loss:5, tie:0 } }, checked:1, changed:1, updated:1, failed:0 });
  assert.deepEqual(locationsForGameChangerLinks(links, await readGameChangerRecords(scope)),
    { opponent:{ city:'Benicia', state:'CA' } });
  assert.deepEqual(locationsForGameChangerLinks({ opponent:url, published:url }, await readGameChangerRecords(scope)),
    { opponent:{ city:'Benicia', state:'CA' }, published:{ city:'Benicia', state:'CA' } });
  assert.deepEqual(recordsForGameChangerLinks({ opponent:url, published:url }, await readGameChangerRecords(scope)),
    { opponent:{ win:5, loss:5, tie:0 }, published:{ win:5, loss:5, tie:0 } });
  assert.deepEqual(namesForGameChangerLinks({ opponent:url, published:url }, await readGameChangerRecords(scope)),
    { opponent:'Outlaws 10U', published:'Outlaws 10U' });
  assert.deepEqual(namesForGameChangerLinks({ opponent:'https://web.gc.com/teams/changed' },
    await readGameChangerRecords(scope)), {});
  assert.deepEqual(calls, ['https://api.team-manager.gc.com/public/teams/example-profile']);
  assert.deepEqual(await refreshGameChangerRecords(scope, links, { teamIds:[], now:now+1000, fetchImpl }),
    { records:{ opponent:{ win:5, loss:5, tie:0 } }, checked:0, changed:0, updated:0, failed:0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await refreshGameChangerRecords(scope, links, { now:now+1000, fetchImpl }),
    { records:{ opponent:{ win:5, loss:5, tie:0 } }, checked:1, changed:0, updated:1, failed:0 });
  assert.equal(calls.length, 2);
  assert.deepEqual(recordsForGameChangerLinks({ opponent:'https://web.gc.com/teams/changed' },
    await readGameChangerRecords(scope)), {});
  assert.deepEqual(locationsForGameChangerLinks({ opponent:'https://web.gc.com/teams/changed' },
    await readGameChangerRecords(scope)), {});
  const failedFetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await refreshGameChangerRecords(scope, links,
    { now:now+7*60*60*1000, fetchImpl:failedFetch }),
  { records:{ opponent:{ win:5, loss:5, tie:0 } }, checked:0, changed:0, updated:0, failed:1 });
  assert.deepEqual(locationsForGameChangerLinks(links, await readGameChangerRecords(scope)),
    { opponent:{ city:'Benicia', state:'CA' } });
  assert.deepEqual(namesForGameChangerLinks(links, await readGameChangerRecords(scope)), { opponent:'Outlaws 10U' });
  assert.deepEqual(await refreshGameChangerRecords(scope, {}, { now:now+8*60*60*1000, fetchImpl }),
    { records:{}, checked:0, changed:0, updated:0, failed:0 });
  assert.deepEqual(await readGameChangerRecords(scope), {});
});

test('scheduled GameChanger record refreshes run every 3 hours, every 30 minutes during a tournament', () => {
  const { gameChangerRecordsRefreshDue:due } = recordsModule;
  const url = 'https://web.gc.com/teams/example-profile';
  const now = Date.parse('2026-10-17T18:00:00Z');
  const checked = minutesAgo => ({ opponent:{ url, checkedAt:new Date(now - minutesAgo * 60000).toISOString() } });
  const dates = ['2026-10-17', '2026-10-18'];
  assert.equal(due({}, {}, { dates, todayPT:'2026-10-17', now }), false);
  assert.equal(due({}, { opponent:'https://example.com/teams/x' }, { dates, todayPT:'2026-10-17', now }), false);
  assert.equal(due({}, { opponent:url }, { todayPT:'2026-10-17', now }), true);
  assert.equal(due({ opponent:{ url:'https://web.gc.com/teams/old', checkedAt:new Date(now).toISOString() } },
    { opponent:url }, { todayPT:'2026-10-17', now }), true);
  // Outside a tournament: 3 hours, allowing a minute of cron jitter.
  assert.equal(due(checked(175), { opponent:url }, { dates, todayPT:'2026-10-16', now }), false);
  assert.equal(due(checked(179), { opponent:url }, { dates, todayPT:'2026-10-16', now }), true);
  assert.equal(due(checked(60), { opponent:url }, { dates, todayPT:'2026-10-19', now }), false);
  // First day through last day (bracket day included when passed in dates): 30 minutes.
  assert.equal(due(checked(25), { opponent:url }, { dates, todayPT:'2026-10-17', now }), false);
  assert.equal(due(checked(29), { opponent:url }, { dates, todayPT:'2026-10-17', now }), true);
  assert.equal(due(checked(29), { opponent:url }, { dates:[...dates, null], todayPT:'2026-10-18', now }), true);
  assert.equal(due(checked(29), { opponent:url }, { dates:['2026-10-18', '2026-10-17'], todayPT:'2026-10-18', now }), true);
  // One stale or missing profile makes the whole set due.
  assert.equal(due({ ...checked(5), other:{ url, checkedAt:new Date(now - 200 * 60000).toISOString() } },
    { opponent:url, other:url }, { todayPT:'2026-10-16', now }), true);
});
