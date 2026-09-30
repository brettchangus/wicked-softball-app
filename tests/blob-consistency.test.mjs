// lib/snapshot.js reads with strong consistency only after the admin function opts in, and only
// when the Netlify runtime provides an uncached edge URL (otherwise every read would throw).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
mock.module(new URL('../netlify/functions/node_modules/@netlify/blobs/dist/main.js', import.meta.url).href, {
  exports: { getStore(options) { calls.push(options); return { get:async () => null, setJSON:async () => {}, delete:async () => {}, list:async () => ({ blobs:[] }) }; } },
});
const storage = await import('../netlify/functions/lib/snapshot.js');
const encode = context => Buffer.from(JSON.stringify(context)).toString('base64');

test('reads stay eventually consistent until opted in, and when the runtime lacks an uncached edge URL', async () => {
  globalThis.netlifyBlobsContext = encode({ siteID:'s', token:'t', uncachedEdgeURL:'https://uncached.example' });
  await storage.readCatalog();
  assert.equal(calls.at(-1), 'tournament');

  storage.useStrongBlobConsistency();
  await storage.readCatalog();
  assert.deepEqual(calls.at(-1), { name:'tournament', consistency:'strong' });

  globalThis.netlifyBlobsContext = encode({ siteID:'s', token:'t' });
  await storage.readCatalog();
  assert.equal(calls.at(-1), 'tournament');
  delete globalThis.netlifyBlobsContext;
});
