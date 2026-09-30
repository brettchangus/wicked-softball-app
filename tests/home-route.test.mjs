import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();

const home = (await import('../netlify/functions/home.js')).default;
const { writeCatalog } = await import('../netlify/functions/lib/snapshot.js');

test('home shows coming soon when no catalog exists', async () => {
  const response = await home(new Request('https://example.test/'));
  assert.equal(response.status,200);
  assert.match(response.headers.get('Content-Type'),/^text\/html/);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.match(await response.text(),/Coming soon/);
  assert.equal(response.headers.get('Location'),null);
});

test('home shows coming soon when the catalog has no usable team and season', async () => {
  await writeCatalog({ defaultTeamKey:null, teams:{} });
  const empty = await home(new Request('https://example.test/'));
  assert.equal(empty.status,200);
  assert.equal(empty.headers.get('Location'),null);

  await writeCatalog({ defaultTeamKey:'another-team', teams:{'another-team':{seasons:{}}} });
  const noSeason = await home(new Request('https://example.test/'));
  assert.equal(noSeason.status,200);
  assert.equal(noSeason.headers.get('Location'),null);
});

test('home redirects to the current catalog default without serving dashboard markup', async () => {
  await writeCatalog({
    defaultTeamKey:'another-team',
    teams:{'another-team':{defaultSeasonKey:'fall-2026',seasons:{'fall-2026':{key:'fall-2026'}}}},
  });
  const response = await home(new Request('https://example.test/?test=1'));
  assert.equal(response.status,302);
  assert.equal(response.headers.get('Location'),'/teams/another-team/seasons/fall-2026?test=1');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(await response.text(),'');
});

test('explicit home context uses a cataloged team and preserves event selection', async () => {
  const response = await home(new Request('https://example.test/?team=another-team&season=fall-2026&eventKey=finals&test=1'));
  assert.equal(response.status,302);
  assert.equal(response.headers.get('Location'),
    '/teams/another-team/seasons/fall-2026?eventKey=finals&test=1');
});
