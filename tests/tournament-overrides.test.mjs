// Pure helpers behind the tournament editor's override model: saveEvent's skip-setup test and the
// score check's placement capture (which must never replace an admin-entered result).
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerInputsUnchanged } from '../netlify/functions/admin.js';
import { applyCapturedPlacement, isManualPlacement } from '../netlify/functions/lib/scores.js';

test('provider corrections compare by content, ignoring key and array order', () => {
  assert.equal(providerInputsUnchanged({}, undefined), true);
  assert.equal(providerInputsUnchanged({ divisionIds:['b','a'], providerTeamId:'t' }, { providerTeamId:'t', divisionIds:['a','b'] }), true);
  assert.equal(providerInputsUnchanged({ providerTeamId:'t' }, { providerTeamId:'u' }), false);
});
test('an explicit empty correction is a change from following detection', () => {
  assert.equal(providerInputsUnchanged({ sisterDivisionIds:[] }, {}), false);
  assert.equal(providerInputsUnchanged({ region:null }, {}), false);
});

const gold2 = { label:'Gold', emoji:'🏆', place:'2nd Place' };
test('captured placement fills both fields when there is no manual result', () => {
  assert.deepEqual(applyCapturedPlacement({ rulesUrl:'r' }, gold2), { rulesUrl:'r', autoPlacement:gold2, knownPlacement:gold2 });
});
test('captured placement never replaces a manual result, but still records the automatic one', () => {
  const manual = { place:1, label:'Champions', source:'manual' };
  assert.deepEqual(applyCapturedPlacement({ knownPlacement:manual }, gold2), { knownPlacement:manual, autoPlacement:gold2 });
  assert.equal(applyCapturedPlacement({ knownPlacement:manual, autoPlacement:gold2 }, gold2), null);
});
test('manual results are flagged, or recognizable by a numeric place from before the flag', () => {
  assert.equal(isManualPlacement({ place:'2nd Place', source:'manual' }), true);
  assert.equal(isManualPlacement({ place:3, label:'Gold' }), true);
  assert.equal(isManualPlacement(gold2), false);
  assert.equal(isManualPlacement(null), false);
  const legacyManual = { knownPlacement:{ place:1, label:'Champions' } };
  assert.deepEqual(applyCapturedPlacement(legacyManual, gold2), { ...legacyManual, autoPlacement:gold2 });
});
test('captured placement is idempotent and corrects a stale automatic result', () => {
  assert.equal(applyCapturedPlacement({ knownPlacement:gold2, autoPlacement:gold2 }, gold2), null);
  const legacy = { knownPlacement:{ label:'Gold', place:'3rd Place' } };   // pre-autoPlacement capture
  assert.deepEqual(applyCapturedPlacement(legacy, gold2), { knownPlacement:gold2, autoPlacement:gold2 });
});
