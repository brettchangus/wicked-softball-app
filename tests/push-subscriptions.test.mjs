import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

const stores = installMemoryBlobStore();

// web-push stand-in: records deliveries; endpoints listed in `gone` answer 410 like an expired device.
const sent = [];
const gone = new Set();
mock.module(new URL('../netlify/functions/node_modules/web-push/src/index.js', import.meta.url).href, {
  exports:{ default:{
    setVapidDetails() {},
    async sendNotification(subscription) {
      if (gone.has(subscription.endpoint)) throw Object.assign(new Error('gone'), { statusCode:410 });
      sent.push(subscription.endpoint);
    },
  } },
});

const { writeCatalog, writeTeam, writeSeason } = await import('../netlify/functions/lib/snapshot.js');
const { subscriptionKey, legacySubscriptionKey } = await import('../netlify/functions/lib/push.js');
const subscribe = (await import('../netlify/functions/subscribe.js')).default;
const notify = (await import('../netlify/functions/notify.js')).default;

const FIREFOX = 'https://updates.push.services.mozilla.com/wpush/v2/';
const subs = () => stores.get('push-subscriptions') || new Map();
const record = key => JSON.parse(subs().get(key) || 'null');
const post = (url, body) => new Request(url, { method:'POST', body:JSON.stringify(body),
  headers:{ 'Content-Type':'application/json' } });
const subscribeWith = (endpoint, games, context) =>
  subscribe(post('https://example.test/subscribe', { subscription:{ endpoint, keys:{} }, games, context }));

const HOME = { teamKey:'home-team', seasonKey:'fall-2026', eventKey:'ev1' };
const AWAY = { teamKey:'away-team', seasonKey:'fall-2026', eventKey:'ev1' };
for (const { teamKey, seasonKey } of [HOME, AWAY]) {
  await writeTeam({ key:teamKey, name:teamKey, defaultSeasonKey:seasonKey });
  await writeSeason({ teamKey, key:seasonKey, name:'Fall 2026', status:'active', featuredEventKey:'ev1',
    events:{ ev1:{ key:'ev1', name:'Event', providerRef:'100', status:'active' } } });
}
await writeCatalog({ defaultTeamKey:HOME.teamKey, teams:Object.fromEntries([HOME, AWAY].map(c => [c.teamKey, {
  key:c.teamKey, name:c.teamKey, defaultSeasonKey:c.seasonKey,
  seasons:{ [c.seasonKey]:{ key:c.seasonKey, name:'Fall 2026', status:'active' } } }])) });

test.beforeEach(() => { subs().clear(); sent.length = 0; gone.clear(); });

test('devices whose endpoints share a long prefix get separate records', async () => {
  const a = `${FIREFOX}device-a`, b = `${FIREFOX}device-b`;
  assert.equal(legacySubscriptionKey(a), legacySubscriptionKey(b)); // the old key collided
  await subscribeWith(a, ['g1'], HOME);
  await subscribeWith(b, ['g2'], HOME);
  assert.equal(record(subscriptionKey(a)).subscription.endpoint, a);
  assert.equal(record(subscriptionKey(b)).subscription.endpoint, b);
});

test('a legacy record is carried over only by the device that owns it', async () => {
  const owner = `${FIREFOX}owner`, other = `${FIREFOX}other`;
  const legacyKey = legacySubscriptionKey(owner);
  subs().set(legacyKey, JSON.stringify({ subscription:{ endpoint:owner }, games:[],
    watches:[{ ...AWAY, gameKey:'old' }] }));

  await subscribeWith(other, ['g1'], HOME);
  assert.ok(subs().has(legacyKey), "another device must not take over or delete the owner's record");
  assert.deepEqual(record(subscriptionKey(other)).watches.map(w => w.gameKey), ['g1']);

  await subscribeWith(owner, ['g2'], HOME);
  assert.equal(subs().has(legacyKey), false);
  assert.deepEqual(record(subscriptionKey(owner)).watches.map(w => `${w.teamKey}:${w.gameKey}`),
    ['away-team:old', 'home-team:g2']);
});

test('un-belling every game does not subscribe a device to default-team broadcasts', async () => {
  process.env.NOTIFY_SECRET = 'notify-secret';
  const optedOut = 'https://push.example.test/opted-out', legacy = 'https://push.example.test/legacy';
  await subscribeWith(optedOut, ['g1'], AWAY);
  await subscribeWith(optedOut, [], AWAY);
  assert.deepEqual(record(subscriptionKey(optedOut)).watches, []);
  // A record from before per-team watches still follows the default team.
  subs().set(subscriptionKey(legacy), JSON.stringify({ subscription:{ endpoint:legacy }, games:['g1'] }));

  const response = await notify(new Request(
    `https://example.test/notify?key=notify-secret&team=${HOME.teamKey}&season=${HOME.seasonKey}&title=Hello`));
  assert.equal(response.status, 200);
  assert.deepEqual(sent, [legacy]);
  delete process.env.NOTIFY_SECRET;
});

test('notify accepts the admin secret and a numeric refresh flag', async () => {
  process.env.ADMIN_SECRET = 'admin-secret';
  const endpoint = 'https://push.example.test/home';
  await subscribeWith(endpoint, ['g1'], HOME);
  const url = `https://example.test/notify?key=admin-secret&team=${HOME.teamKey}&season=${HOME.seasonKey}`;
  const body = await (await notify(post(url, { title:'Hi', refresh:1 }))).json();
  assert.equal(body.refresh, true);
  assert.equal(body.sent, 1);
  const denied = await notify(post(url.replace('admin-secret', 'wrong'), { title:'Hi' }));
  assert.equal(denied.status, 403);
  delete process.env.ADMIN_SECRET;
});

test('notify accepts the admin setup fallback with a separate notification secret', async () => {
  const names = ['ADMIN_SECRET', 'NOTIFY_SECRET', 'SETUP_SECRET'];
  const previous = names.map(name => process.env[name]);
  delete process.env.ADMIN_SECRET;
  process.env.NOTIFY_SECRET = 'notify-secret';
  process.env.SETUP_SECRET = 'setup-secret';
  try {
    const endpoint = 'https://push.example.test/admin-fallback';
    await subscribeWith(endpoint, ['g1'], HOME);
    const url = 'https://example.test/notify?team=' + HOME.teamKey + '&season=' + HOME.seasonKey;
    for (const key of ['setup-secret', 'notify-secret']) {
      const response = await notify(post(url + '&key=' + key, { title:'Hi' }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sent, 1);
    }
    assert.deepEqual(sent, [endpoint, endpoint]);
    assert.equal((await notify(post(url + '&key=wrong', { title:'Hi' }))).status, 403);
    // An explicit admin secret replaces its setup fallback.
    process.env.ADMIN_SECRET = 'admin-secret';
    assert.equal((await notify(post(url + '&key=setup-secret', { title:'Hi' }))).status, 403);
    assert.equal((await notify(post(url + '&key=admin-secret', { title:'Hi' }))).status, 200);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('an expired subscription is pruned under the key it was stored with', async () => {
  process.env.NOTIFY_SECRET = 'notify-secret';
  const endpoint = `${FIREFOX}expired`;
  const legacyKey = legacySubscriptionKey(endpoint);
  subs().set(legacyKey, JSON.stringify({ subscription:{ endpoint }, games:[] }));
  gone.add(endpoint);
  await notify(new Request(
    `https://example.test/notify?key=notify-secret&team=${HOME.teamKey}&season=${HOME.seasonKey}&title=Hello`));
  assert.equal(subs().has(legacyKey), false);
  delete process.env.NOTIFY_SECRET;
});
