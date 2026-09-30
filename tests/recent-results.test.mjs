import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRecentResults, recentResultsFromSnapshots } from '../netlify/functions/lib/recent-results.js';

const tournament = {
  meta:{ eventId:'demo-event', name:'Demo tournament', providerTeamId:'mine' },
  pools:{ A:{ games:[
    { key:'p1', time:'2026-09-19T08:00:00', hid:'mine', hn:'My team', aid:'one', an:'Team One' },
    { key:'p2', time:'2026-09-19T10:00:00', hid:'two', hn:'Team Two', aid:'mine', an:'My team' },
    { key:'p3', time:'2026-09-19T12:00:00', hid:'mine', hn:'My team', aid:'three', an:'Team Three' },
  ] } },
  results:{
    p1:{ topScore:12, botScore:0, status:'completed' },
    p2:{ topScore:3, botScore:4, status:'completed' },
    p3:{ topScore:13, botScore:1, status:'completed' },
  },
  bracketGames:{ championship:[
    { key:'b1', time:'2026-09-20T08:00:00', topId:'mine', topName:'My team',
      botId:'four', botName:'Team Four', topScore:4, botScore:12, status:'completed' },
  ] },
};

test('completed pool and bracket games from the last tournament appear in Recent Results', () => {
  const result = recentResultsFromSnapshots([tournament]);
  assert.equal(result.games.length, 4);
  assert.deepEqual(result.games.map(g => g.score), ['12-0', '4-3', '13-1', '4-12']);
  assert.equal(result.tournaments[0].name, 'Demo tournament');
  assert.equal(result.tournaments[0].record, '3-1');
  assert.equal(result.tournaments[0].pf, 33);
  assert.equal(result.tournaments[0].pa, 16);
});

test('snapshot games supplement empty team history without duplicating existing history', () => {
  const empty = mergeRecentResults({ season:'0-0', games:[], tournaments:[] }, [tournament]);
  assert.equal(empty.games.length, 4);
  assert.equal(empty.games[0].score, '4-12');
  assert.equal(empty.season, '0-0');

  const alreadyPresent = mergeRecentResults({ games:[{ eventId:tournament.meta.eventId, score:'1-0' }] }, [tournament]);
  assert.equal(alreadyPresent.games.length, 1);
});
