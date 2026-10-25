import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';

installMemoryBlobStore();
process.env.ANTHROPIC_API_KEY = 'test-api-key';
const { writeCatalog, writeTeam, writeSeason, writeStructure, writeScopedArchive, readStructure } =
  await import('../netlify/functions/lib/snapshot.js');
const { createArchiveBundle } = await import('../netlify/functions/lib/archive.js');
const chat = (await import('../netlify/functions/chat.js')).default;

// `stored` / `archive` / `static` are where a completed season's earlier tournament is read from.
// `active` is an ongoing season, whose prompt has no game log — so nothing is read for it.
for (const storage of ['stored', 'archive', 'static', 'active']) {
  test(`chat applies each tournament's opponent edits to season history (${storage})`, async t => {
    const active = storage === 'active';
    const teamKey = `history-${storage}`, seasonKey = 'example-season';
    const scope = eventKey => ({ teamKey, seasonKey, eventKey });
    const team = { key:teamKey, name:'Example Team', defaultSeasonKey:seasonKey };
    const events = {
      earlier:{ key:'earlier', name:'Earlier Cup', providerRef:'100',
        config:{ opponents:{ opp:{ name:'Edited Past', coach:'Updated Coach' } } },
        ...(storage === 'static' || active ? { snapshotPath:'data/earlier.json' } : {}) },
      current:{ key:'current', name:'Current Cup', providerRef:'200',
        config:{ opponents:{ opp:{ name:'Edited Current' } } } },
      untouched:{ key:'untouched', name:'Other Cup', providerRef:'300', config:{} },
    };
    const season = { teamKey, key:seasonKey, name:'Example Season', status:active ? 'active' : 'completed', featuredEventKey:'current',
      ...(storage === 'archive' ? { archiveVersion:1 } : {}),
      teamConfig:{}, events, seasonData:Object.values(events).map(event => ({
        key:event.key, name:event.name, providerRef:event.providerRef,
      })) };
    await writeCatalog({ defaultTeamKey:teamKey, teams:{ [teamKey]:{ ...team,
      seasons:{ [seasonKey]:{ key:seasonKey, name:season.name, status:season.status } } } } });
    await writeTeam(team);
    const tournament = key => ({ meta:{ eventId:events[key].providerRef, name:events[key].name,
      provider:'norcal', providerTeamId:'ours' }, pools:{ A:{
      teams:[{ id:'ours', name:'Example Team' }, { id:'opp', name:'Provider Opponent' }], games:[],
    } }, brackets:[] });
    const past = tournament('earlier'), current = tournament('current'), untouched = tournament('untouched');
    current.meta.wicked = { season:'3-0', games:Object.keys(events).map(key => ({
      eventId:events[key].providerRef, event:events[key].name, oppId:'opp', opp:'Provider Opponent',
      date:'2026-08-01', res:'W', score:'2-1',
    })), tournaments:[] };

    if (storage === 'archive') {
      const frozenSeason = structuredClone(season);
      frozenSeason.events.earlier.config.opponents.opp = { name:'Archived Past' };
      const bundle = createArchiveBundle({ team, season:frozenSeason, featuredEvent:events.current,
        featuredSnapshot:current, eventSnapshots:{ earlier:past, untouched } });
      await writeScopedArchive(bundle);
      // Live structures may change after the frozen season. Its stored archive remains authoritative.
      await writeStructure('100', { ...past, pools:{} }, scope('earlier'));
    } else if (storage === 'stored') {
      await writeStructure('100', past, scope('earlier'));
    }
    await writeStructure('200', current, scope('current'));
    await writeSeason(season);
    let prompt, staticReads = 0;
    t.mock.method(globalThis, 'fetch', async (target, init) => {
      if (new URL(target).pathname === '/data/earlier.json') {
        staticReads++;
        return Response.json(past);
      }
      assert.equal(String(target), 'https://api.anthropic.com/v1/messages');
      prompt = JSON.parse(init.body).system[1].text;
      return Response.json({ id:'test-message', type:'message', role:'assistant', model:'test',
        content:[{ type:'text', text:'Test response' }], stop_reason:'end_turn',
        usage:{ input_tokens:1, output_tokens:1 } });
    });
    const response = await chat(new Request('http://localhost/api/chat', { method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ context:scope('current'), question:'Who did we play this season?' }) }));
    assert.equal(response.status, 200);
    if (active) {
      assert.doesNotMatch(prompt, /Earlier Cup — W/);
    } else {
      assert.match(prompt, /Earlier Cup — W 2–1 vs Edited Past - Updated Coach/);
      assert.match(prompt, /Current Cup — W 2–1 vs Edited Current/);
      assert.match(prompt, /Other Cup — W 2–1 vs Provider Opponent/);
      assert.doesNotMatch(prompt, /Earlier Cup — W 2–1 vs (Provider Opponent|Archived Past)/);
    }
    assert.equal(staticReads, storage === 'static' ? 1 : 0);
    assert.equal((await readStructure('200', scope('current'))).meta.wicked.games[0].opp, 'Provider Opponent');
  });
}
