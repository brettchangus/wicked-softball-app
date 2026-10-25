import test from 'node:test';
import assert from 'node:assert/strict';
import { assignedTeamId, extractBracketFrame } from '../netlify/functions/lib/norcal.js';
import { extractBracketGames } from '../netlify/functions/lib/scores.js';

// Before the bracket is seeded, NorCal fills every slot with teamID "0" and a seed label.
const bracket = { bracket:{ roundSets:[{ index:3, rounds:[{ games:[{
  _key:'g1', gameNo:1, topSeed:4, botSeed:5, topSeedDisplay:4, botSeedDisplay:5,
  topTeam:{ teamID:'0', label:'10U Pool P -  4th Overall' },
  botTeam:{ teamID:'example-team', label:'Wicked Elite - Agar' },
}] }] }] } };

test('assignedTeamId drops only NorCal\'s unassigned-slot id', () => {
  assert.equal(assignedTeamId('0'), null);
  assert.equal(assignedTeamId(0), null);
  assert.equal(assignedTeamId(null), null);
  assert.equal(assignedTeamId('example-team'), 'example-team');
});

test('the setup bracket frame leaves an unassigned NorCal slot empty', () => {
  const [game] = extractBracketFrame(bracket);
  assert.equal(game.topId, null);
  assert.equal(game.topName, null);
  assert.equal(game.topSeed, 4);
  assert.equal(game.botId, 'example-team');
});

test('live bracket games leave an unassigned NorCal slot without a team id', () => {
  const [game] = extractBracketGames(bracket);
  assert.equal(game.topId, null);
  assert.equal(game.topSeed, 4);
  assert.equal(game.botId, 'example-team');
});
