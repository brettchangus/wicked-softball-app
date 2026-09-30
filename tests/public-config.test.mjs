import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultModel, DEFAULT_SEASON_DATA, publicCatalog } from '../netlify/functions/lib/context.js';
import {
  DEFAULT_EVENT_KEY, DEFAULT_SEASON_KEY, DEFAULT_TEAM_KEY,
  MY_ID, PUBLIC_EVENT_ID, RULES_URL, TEAM_NAME,
} from '../netlify/functions/lib/tournament.js';

test('the source does not seed a real team or season', () => {
  assert.deepEqual(DEFAULT_SEASON_DATA, []);
  assert.equal(PUBLIC_EVENT_ID, null);
  assert.equal(MY_ID, '');
  assert.equal(RULES_URL, '');
  assert.equal(TEAM_NAME, 'Team');
  assert.equal(DEFAULT_TEAM_KEY, 'team');
  assert.equal(DEFAULT_SEASON_KEY, 'season');
  assert.equal(DEFAULT_EVENT_KEY, 'current-tournament');
});

test('an empty catalog is safe to expose before demo data is seeded', () => {
  assert.deepEqual(publicCatalog({ schemaVersion:2, defaultTeamKey:null, teams:{} }), {
    schemaVersion:2, defaultTeamKey:null, teams:{},
  });
});

test('legacy data is read from provided records, not a committed fixture', () => {
  const record = { key:'scrimmage', name:'Example Scrimmage', providerRef:'tm:sample:division:team' };
  const model = buildDefaultModel({ seasonData:[record] }, record.providerRef);
  assert.equal(model.season.seasonData.length, 1);
  assert.equal(model.season.events.scrimmage.providerRef, record.providerRef);
  assert.equal(model.team.name, 'Team');
});
