import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').replaceAll('\r\n','\n');
const adminSource = fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
function client(name, globals={}) {
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0);
  const tail=source.slice(start), end=tail.search(/^}/m)+1;
  return vm.runInNewContext(`(${tail.slice(0,end)})`,globals);
}
test('coach and GameChanger location share one escaped secondary line',()=>{
  const render=client('gameChangerLocationHtml',{
    GAMECHANGER_LOCATIONS:{ ours:{ city:'Example <City> G', state:'CA' } },
    // A team the server resolved (admin edits → provider → GameChanger) uses those parts as-is.
    TEAM_DISPLAY:{ resolved:{ name:'Example Club', coach:'', city:'Example City F', state:'NV', providerName:'Example Club 10B - Example City F' },
      edited:{ name:'Example Club', coach:'Edited Coach', city:'', state:'', providerName:'Example Club B - Provider Coach' } },
    splitRosterName:client('splitRosterName'), MY_ID:'ours', AST_TEAM_NAME:'Example Team-Sample Coach',
    historyEsc:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;')
  });
  assert.equal(render('ours', 'Example Team - Sample Coach'), '<span class="team-location">Sample Coach · Example &lt;City&gt; G, CA</span>');
  assert.equal(render('ours', 'Example Team'), '<span class="team-location">Sample Coach · Example &lt;City&gt; G, CA</span>');
  assert.equal(render('missing', 'Example Opponents A-Sample Coach'), '<span class="team-location">Sample Coach</span>');
  assert.equal(render('missing'), '');
  assert.equal(render('resolved', 'Example Club 10B - Example City F'), '<span class="team-location">Example City F, NV</span>');
  assert.equal(render('edited', 'Example Club - Edited Coach'), '<span class="team-location">Edited Coach</span>');
});

test('admin auto-unlock keeps the stored secret; only a typed secret replaces it',async()=>{
  const start=adminSource.indexOf('async function unlock(');
  assert.ok(start>=0);
  const body=adminSource.slice(start), source=body.slice(0, body.search(/^}/m)+1);
  const stored=new Map([['exampleAdminKey','saved-secret']]);
  const usedSecrets=[], classes=()=>({classList:{add(){},remove(){}}});
  const globals={ KEYK:'exampleAdminKey', toast(){},
    localStorage:{ getItem:key=>stored.get(key) ?? null, setItem:(key,value)=>stored.set(key,value) },
    $:selector=>selector==='#secret' ? { value:'' } : classes(),
    loadAll:async()=>{ usedSecrets.push(stored.get('exampleAdminKey')); } };
  const unlock=vm.runInNewContext(`(${source})`,globals);
  await unlock();
  assert.equal(stored.get('exampleAdminKey'),'saved-secret');
  await unlock('  typed-secret ');
  assert.equal(stored.get('exampleAdminKey'),'typed-secret');
  assert.deepEqual(usedSecrets,['saved-secret','typed-secret']);

  // The wiring: load calls unlock() with nothing; the button and Enter pass the typed value, never
  // the click event.
  const wiringStart=adminSource.indexOf('const unlockTyped');
  const wiringEnd=adminSource.indexOf('if (adminKey()) unlock();',wiringStart);
  assert.ok(wiringStart>=0 && wiringEnd>wiringStart);
  const calls=[], button={}, field={ value:'typed', addEventListener(_type,handler){ this.keydown=handler; } };
  vm.runInNewContext(adminSource.slice(wiringStart,wiringEnd)+'if (adminKey()) unlock();',{
    $:selector=>selector==='#secret' ? field : button, adminKey:()=>'saved-secret', unlock:(...args)=>calls.push(args) });
  assert.deepEqual(calls,[[]]);
  button.onclick({type:'click'});
  field.keydown({key:'a'});
  field.keydown({key:'Enter'});
  assert.deepEqual(calls,[[],['typed'],['typed']]);
});

test('admin record refresh displays returned records even after a stale snapshot read', async () => {
  const source = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const start = source.indexOf("$('#gcRefreshRecords')?.addEventListener('click'");
  const end = source.indexOf('\n});', start) + 4;
  assert.ok(start >= 0 && end > start);
  const snap = { config:{ gameChangerRecords:{ opp:{ win:1, loss:1, tie:0 } } } };
  let click, displayed;
  vm.runInNewContext(source.slice(start, end), {
    $:() => ({ addEventListener:(_event, handler) => { click = handler; } }),
    confirmAction:async () => true,
    contextQuery:() => 'team=test&season=fall-2026',
    api:async action => {
      assert.equal(action, 'refreshGameChangerRecords');
      return { records:{ opp:{ win:2, loss:1, tie:0 } }, checked:1, changed:1, failed:0 };
    },
    run:async (request, message) => { const result = await request(); message(result); return result; },
    SNAP:snap,
    renderOpponents:() => { displayed = snap.config.gameChangerRecords.opp; },
  });
  await click();
  assert.deepEqual(displayed, { win:2, loss:1, tie:0 });
});

test('edited names with dashes stay intact and badge colors remain stable',()=>{
  const display={ opp:{ name:'Example-Region Club', providerName:'Original Example Club 10B - Sample Coach' } };
  const short=client('shortTeam',{ TEAM_DISPLAY:display });
  assert.equal(short('Example-Region Club - Sample Coach','opp'),'Example-Region Club');
  const color=client('teamBadgeColor',{ TEAM_DISPLAY:display });
  assert.equal(color('opp','Example-Region Club - Sample Coach'),color('opp','Original Example Club 10B - Sample Coach'));
});

test('the level badge is judged against the name on screen, not the provider name',()=>{
  const TEAM_DISPLAY={
    magic:{ name:'Example Magic', level:'C', providerName:"Example Magic 10C - Fall 2026 (Coach One)" },
    smoke:{ name:'Example Smoke', level:'C', providerName:'Example Smoke 10uC' },
    kept:{ name:'Example Blaze 10B', providerName:'Example Blaze 10B - Coach Three' },
    red:{ name:'Example Red', providerName:'Example 10U Red' },
    black:{ name:'Example Rebels Black', providerName:'Example Rebels - Fall - 10U Black - Coach Five' },
    regional:{ name:'Example Club F', providerName:'Example Club F 10U - Coach Six' },
    queens:{ name:'Example Queens', level:'C', providerName:'Example Queens Fall Ball 10U (1)' },
    older:{ name:'Example Club', level:'B', providerName:'Example Club 12B - Sample Coach' },
  };
  const globals={ TEAM_DISPLAY, splitRosterName:client('splitRosterName') };
  globals.nameHasLevel=vm.runInNewContext(
    source.match(/const nameHasLevel = (.*);\n/)[1], globals);
  const badge=client('teamLevelBadge',globals);
  // The level was only in the provider's name, which the edited name no longer shows.
  assert.equal(badge('magic','Example Magic - Coach One',null),'C');
  assert.equal(badge('smoke','Example Smoke - Coach Two',undefined),'C');
  assert.equal(badge('older','Example Club - Sample Coach',null),'B');
  // The provider reported a level and the name on screen lacks it.
  assert.equal(badge('queens','Example Queens - Coach Seven','C'),'C');
  // Already on screen, or not known at all: no badge.
  assert.equal(badge('kept','Example Blaze 10B - Coach Three','B'),'');
  assert.equal(badge('kept','Example Blaze 10B - Coach Three',null),'');
  assert.equal(badge('red','Example Red - Coach Four',null),'');
  assert.equal(badge('black','Example Rebels Black - Coach Five',null),'');
  assert.equal(badge('regional','Example Club F - Coach Six',null),'');
  // No resolved entry (local fixture): falls back to the printed name.
  assert.equal(badge('unknown','Example Tremors 10U Black','B'),'');
  assert.equal(badge('unknown','Example Slammers 10U B - Coach Eight','B'),'');
});

// The snapshot's pool teams are copied field by field into POOLS, so a field the badge needs is
// lost unless it is listed there (registeredLevel was: the badge never showed for 0-0 teams).
test('pool teams keep bracket levels while display classes come from the server',()=>{
  const mapping=source.match(/teams: (\(p\.teams \|\| \[\]\)\.map\(t => \(\{.*\}\)\)),\n/);
  assert.ok(mapping, 'pool team mapping');
  const teams=vm.runInNewContext(mapping[1],{ MY_ID:'mine', SISTER_ID:null,
    p:{ teams:[{ id:'mine', name:'Ours', sr:'0-0', registeredLevel:'B' },
      { id:'opp', name:'Example Club', sr:'4-1', level:'C', registeredLevel:'C', city:'Example City F' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(teams)),[
    { id:'mine', name:'Ours', sr:'0-0', me:true, sister:false },
    { id:'opp', name:'Example Club', sr:'4-1', level:'C', me:false, sister:false }]);
});
