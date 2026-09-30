// ensureScopedModel runs on public requests (/api/catalog, /api/snapshot, the cron). Neither a
// failed catalog read nor a stale eventually consistent "not found" may be mistaken for a missing
// catalog: the empty-site path would hide every team, and the legacy migration would replace the
// catalog with one rebuilt from older records.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const data = new Map();          // what a strongly consistent read sees
const staleNull = new Set();     // keys an eventually consistent read still reports missing
const failingGets = new Set();
const writes = [];
mock.module(new URL('../netlify/functions/node_modules/@netlify/blobs/dist/main.js', import.meta.url).href, {
  exports: {
    getStore(options) {
      const strong = options?.consistency === 'strong';
      return {
        async get(key, opts) {
          if (failingGets.has(key)) throw new Error(`blob read failed: ${key}`);
          if (!strong && staleNull.has(key)) return null;
          const value = data.get(key);
          if (value === undefined) return null;
          return opts?.type === 'json' ? JSON.parse(value) : value;
        },
        async set(key, value) { writes.push(key); data.set(key, String(value)); },
        async setJSON(key, value) { writes.push(key); data.set(key, JSON.stringify(value)); },
        async delete(key) { writes.push(key); data.delete(key); },
        async list() { return { blobs:[] }; },
      };
    },
  },
});
const { ensureScopedModel, readCatalog } = await import('../netlify/functions/lib/snapshot.js');
const seasonArchive = (await import('../netlify/functions/season-archive.js')).default;

const configured = {
  schemaVersion:2, defaultTeamKey:'example-club',
  teams:{ 'example-club':{ key:'example-club', name:'Example Club', defaultSeasonKey:'fall-2026',
    seasons:{ 'fall-2026':{ key:'fall-2026', name:'Fall 2026', status:'active' } } } },
};
const legacyRef = 'tm:tournament:division:team';
const EMPTY = { schemaVersion:2, defaultTeamKey:null, teams:{} };
const strongReads = available => {
  if (available) globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify(
    { siteID:'site', token:'token', uncachedEdgeURL:'https://uncached.example.test' })).toString('base64');
  else delete globalThis.netlifyBlobsContext;
};
const reset = ({ catalog = null, legacy = false, stale = false, strong = true } = {}) => {
  data.clear(); staleNull.clear(); failingGets.clear(); writes.length = 0;
  if (catalog) data.set('v2:catalog', JSON.stringify(catalog));
  if (stale) staleNull.add('v2:catalog');
  if (legacy) {
    data.set('config', JSON.stringify({ seasonData:[{ key:'legacy-event', name:'Legacy Event', providerRef:legacyRef }], events:{} }));
    data.set('activeEventId', legacyRef);
  }
  strongReads(strong);
};

test('an existing catalog is returned unchanged', async () => {
  reset({ catalog:configured });
  assert.deepEqual(await ensureScopedModel(), configured);
  assert.deepEqual(writes, []);
});

test('a failed catalog read throws instead of replacing the catalog', async () => {
  reset({ catalog:configured, legacy:true });
  failingGets.add('v2:catalog');
  await assert.rejects(ensureScopedModel(), /blob read failed/);
  assert.deepEqual(writes, []);
  assert.deepEqual(JSON.parse(data.get('v2:catalog')), configured);
});

test('a stale not-found read does not re-run the migration over a published catalog', async () => {
  reset({ catalog:configured, legacy:true, stale:true });
  assert.deepEqual(await ensureScopedModel(), configured);
  assert.deepEqual(writes, []);
});

test('a stale not-found read on a site without legacy records does not look empty', async () => {
  reset({ catalog:configured, stale:true });
  assert.deepEqual(await ensureScopedModel(), configured);
  assert.deepEqual(writes, []);
});

test('without strong reads, legacy migration is refused until an admin asks for it', async () => {
  reset({ catalog:configured, legacy:true, stale:true, strong:false });
  await assert.rejects(ensureScopedModel(), err => err.code === 'catalogMigrationUnconfirmed');
  assert.deepEqual(writes, []);
  assert.deepEqual(JSON.parse(data.get('v2:catalog')), configured);
});

test('a strongly confirmed absence migrates legacy records and publishes the catalog last', async () => {
  reset({ legacy:true });
  const catalog = await ensureScopedModel();
  assert.ok(catalog.teams[catalog.defaultTeamKey]);
  assert.equal(writes.at(-1), 'v2:catalog');
  assert.deepEqual(JSON.parse(data.get('v2:catalog')), catalog);
});

test('an explicit admin migration runs without strong reads', async () => {
  reset({ legacy:true, strong:false });
  const catalog = await ensureScopedModel({ migrateLegacy:true });
  assert.ok(catalog.teams[catalog.defaultTeamKey]);
  assert.equal(writes.at(-1), 'v2:catalog');
});

test('a new site gets an empty catalog without persisting one', async () => {
  for (const strong of [true, false]) {
    reset({ strong });
    assert.deepEqual(await ensureScopedModel(), EMPTY);
    assert.deepEqual(writes, []);
  }
});

test('read-only callers still treat a failed catalog read as absent', async () => {
  reset();
  failingGets.add('v2:catalog');
  assert.equal(await readCatalog(), null);
});

test('the season archive endpoint rejects cleanly on a new site', async () => {
  reset();
  const response = await seasonArchive(new Request('https://example.test/api/season-archive'));
  assert.equal(response.status, 400);
  assert.deepEqual(writes, []);
});

// Last: admin.js opts the whole module graph into strong reads when it loads.
test('the admin page gets a 409 it can resolve with the explicit migration action', async () => {
  process.env.ADMIN_SECRET = 'secret';
  const admin = (await import('../netlify/functions/admin.js')).default;
  const call = (action, payload = {}) => admin(new Request('https://example.test/admin?key=secret', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action, ...payload }),
  }));

  reset({ legacy:true, strong:false });
  const refused = await call('getCatalog');
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'catalogMigrationUnconfirmed');
  // Action helpers are awaited inside the handler's try, so their errors get the same response.
  const refusedCreate = await call('createTeam', { team:{ key:'new-club', name:'New Club', norcalTeamId:'1234567890' } });
  assert.equal(refusedCreate.status, 409);
  assert.equal((await refusedCreate.json()).code, 'catalogMigrationUnconfirmed');
  assert.deepEqual(writes, []);

  const migrated = await call('migrateLegacyCatalog');
  assert.equal(migrated.status, 200);
  const { catalog } = await migrated.json();
  assert.ok(catalog.teams[catalog.defaultTeamKey]);
  assert.equal(writes.at(-1), 'v2:catalog');
  delete process.env.ADMIN_SECRET;
});
