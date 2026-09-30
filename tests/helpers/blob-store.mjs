// In-memory stand-in for @netlify/blobs, for integration tests that exercise code paths going
// through lib/snapshot.js's Blob-backed catalog/team/season records (resolveContext,
// ensureScopedModel, admin.js's handler) without real Netlify Blobs credentials or network.
//
// Must be called via installMemoryBlobStore() BEFORE any module that imports '@netlify/blobs' is
// itself imported (Node caches the resolved ES module graph, so the mock has to be registered
// first) — dynamic `await import(...)` the module under test after calling this. Requires the
// process to run with --experimental-test-module-mocks (see the root "Run the tests" command).
import { mock } from 'node:test';

// mock.module() resolves its specifier using normal Node module resolution FROM THIS FILE's own
// location — a bare `'@netlify/blobs'` won't resolve here since the package only lives under
// netlify/functions/node_modules (a sibling directory tree, not an ancestor of tests/helpers/).
// Point it at the already-resolved absolute entry file instead, which any importer inside
// netlify/functions/ (admin.js, lib/snapshot.js, ...) resolves to as well, so the mock still
// takes effect for them despite being registered from outside that tree.
const BLOBS_ENTRY = new URL(
  '../../netlify/functions/node_modules/@netlify/blobs/dist/main.js', import.meta.url,
).href;

export function installMemoryBlobStore() {
  // An in-memory store is always consistent, so advertise the runtime's strong-read support
  // (lib/snapshot.js strongReadsAvailable), as a deployed Netlify function does.
  globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify(
    { siteID:'memory', token:'memory', uncachedEdgeURL:'https://uncached.memory.test' })).toString('base64');
  const stores = new Map(); // store name -> Map(key -> string)
  Object.defineProperty(stores, 'operations', { value:[], enumerable:false });
  const storeFor = name => {
    const key = typeof name === 'string' ? name : name?.name;
    if (!stores.has(key)) stores.set(key, new Map());
    return stores.get(key);
  };
  mock.module(BLOBS_ENTRY, {
    exports: {
      getStore(name) {
        const data = storeFor(name);
        const storeName = typeof name === 'string' ? name : name?.name;
        return {
          async get(key, opts) {
            stores.operations.push({ store:storeName, operation:'get', key });
            const v = data.get(key);
            if (v === undefined) return null;
            return opts?.type === 'json' ? JSON.parse(v) : v;
          },
          async set(key, value) { stores.operations.push({ store:storeName, operation:'set', key }); data.set(key, String(value)); },
          async setJSON(key, value) { stores.operations.push({ store:storeName, operation:'set', key }); data.set(key, JSON.stringify(value)); },
          async delete(key) { stores.operations.push({ store:storeName, operation:'delete', key }); data.delete(key); },
          async list(options = {}) {
            stores.operations.push({ store:storeName, operation:'list', prefix:options.prefix || '' });
            const prefix = options.prefix || '';
            return {
              blobs:[...data.keys()].filter(key => key.startsWith(prefix))
                // Real Blob listings include an etag. Using the stored value gives tests the same
                // cache-invalidation behavior without depending on a particular hash algorithm.
                .map(key => ({ key, etag:data.get(key) })),
            };
          },
        };
      },
    },
  });
  return stores;
}
