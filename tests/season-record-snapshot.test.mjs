import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();
const { writeCatalog, writeTeam, writeSeason, writeStructure, writeResults } =
  await import('../netlify/functions/lib/snapshot.js');
const { default:handler } = await import('../netlify/functions/snapshot.js');

test('snapshot header record combines completed NorCal and AST tournament scores', async () => {
  const teamKey = 'record-team', seasonKey = 'fall-2026';
  const events = {
    norcal:{ key:'norcal', name:'NorCal', providerRef:'100', status:'completed' },
    ast:{ key:'ast', name:'AST', providerRef:'https://allstartournaments.com/fastpitch/example/', status:'active' },
  };
  await writeCatalog({ defaultTeamKey:teamKey, teams:{
    [teamKey]:{ key:teamKey, name:'Record Team', defaultSeasonKey:seasonKey,
      seasons:{ [seasonKey]:{ key:seasonKey, name:'Fall 2026', status:'active' } } },
  } });
  await writeTeam({ key:teamKey, name:'Record Team', defaultSeasonKey:seasonKey });
  await writeSeason({ teamKey, key:seasonKey, name:'Fall 2026', status:'active',
    featuredEventKey:'ast', events });

  for (const [eventKey, score] of [['norcal', [4, 1]], ['ast', [2, 5]]]) {
    const scope = { teamKey, seasonKey, eventKey };
    const event = events[eventKey];
    await writeStructure(event.providerRef, {
      meta:{ providerTeamId:'mine', provider:eventKey, wicked:{ season:'10-2', rank:3, rankOf:20 } },
      poolOrder:['A'], pools:{ A:{ games:[{ key:'game', hid:'mine', aid:'other' }] } }, brackets:[],
    }, scope);
    await writeResults(event.providerRef, { games:{
      game:{ topScore:score[0], botScore:score[1], status:'completed' },
    } }, scope);
  }
  const request = new Request(`https://example.netlify.app/api/snapshot?team=${teamKey}&season=${seasonKey}`);
  const first = await (await handler(request)).json();
  assert.equal(first.wicked.season, '10-3');
  assert.equal(first.wicked.rank, 3);

  await writeResults(events.ast.providerRef, { games:{
    game:{ topScore:6, botScore:5, status:'completed' },
  } }, { teamKey, seasonKey, eventKey:'ast' });
  const corrected = await (await handler(request)).json();
  assert.equal(corrected.wicked.season, '11-2');
});
