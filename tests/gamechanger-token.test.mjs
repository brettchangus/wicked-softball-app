import test from 'node:test';
import assert from 'node:assert/strict';
import { searchGameChangerTeams } from '../netlify/functions/lib/gamechanger-search.js';

test('search requires a page token even when an environment token exists', async () => {
  const previous = process.env.GAMECHANGER_TOKEN;
  process.env.GAMECHANGER_TOKEN = 'unused-environment-token';
  try {
    for (const token of [undefined, '', '   ']) {
      await assert.rejects(searchGameChangerTeams('Example', { token }, async () => {
        assert.fail('missing page tokens must not make a request');
      }), /^Error: Enter a GameChanger token in the admin page$/);
    }
  } finally {
    if (previous === undefined) delete process.env.GAMECHANGER_TOKEN;
    else process.env.GAMECHANGER_TOKEN = previous;
  }
});

test('search sends only the explicitly supplied page token', async () => {
  let calls = 0;
  const candidates = await searchGameChangerTeams('Example', { token:'  page-token  ' }, async (_url, init) => {
    calls++;
    assert.equal(init.headers['gc-token'], 'page-token');
    return Response.json({ hits:[] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(candidates, []);
});
