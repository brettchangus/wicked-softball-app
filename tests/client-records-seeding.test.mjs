import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import TournamentProjection from '../assets/projections.js';
const source = fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function client(name, globals={}) {
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0);
  const tail=source.slice(start), end=tail.search(/^}/m)+1;
  return vm.runInNewContext(`(${tail.slice(0,end)})`,{TournamentProjection,bracketGameData:{},POOL_KEYS:[],SEEDING_RULES:null,projectionSnapshot:null,...globals});
}
test('mixed official ranks sort consistently across all input permutations',()=>{
  const sort=client('sortStandingsTeams');
  const a={id:'a',officialRank:1,w:1}, b={id:'b',officialRank:null,w:2}, c={id:'c',officialRank:2,w:3};
  for(const rows of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
    assert.equal(sort(rows).map(t=>t.id).join(','),'c,b,a');
  }
  b.officialRank=3;
  assert.equal(sort([c,b,a]).map(t=>t.id).join(','),'a,c,b');
  assert.equal(sort([{id:'z',w:0},{id:'a',w:0}]).map(t=>t.id).join(','),'a,z');
  assert.equal(sort([{id:'opponent',w:0,officialRank:1},{id:'ours',w:0,officialRank:2,me:true}])
    .map(t=>t.id).join(','),'opponent,ours');
  assert.equal(sort([{id:'opponent',w:1,officialRank:1},{id:'ours',w:0,officialRank:2,me:true}])
    .map(t=>t.id).join(','),'opponent,ours');
});

test('standings put the tracked team first only within unresolved seeding ties',()=>{
  const sort=client('sortStandingsTeams');
  const ours={id:'ours',me:true,w:1,l:1,ra:5,rf:8};
  const tied={id:'a-tied',w:1,l:1,ra:5,rf:8};
  const better={id:'better',w:1,l:1,ra:2,rf:8};
  assert.equal(sort([tied,ours,better], 'officialPoolRank', true).map(t=>t.id).join(','),'better,ours,a-tied');
  const posted=[tied,ours,better].map((t,i)=>({...t,officialPoolRank:i+1}));
  assert.equal(sort(posted, 'officialPoolRank', true).map(t=>t.id).join(','),'a-tied,ours,better');
});

test('Tracked team display preference respects win percentage and configured tiebreakers',()=>{
  const sort=client('sortStandingsTeams',{
    SEEDING_RULES:{verified:true,primary:'winPercentage',tiebreakers:['runsAllowed','runsScored']},
    projectionSnapshot:{pools:{},results:{}}
  });
  const rows=[
    {id:'ours',me:true,w:3,l:3,ra:5,rf:8},
    {id:'a-tied',w:1,l:1,ra:5,rf:8},
    {id:'better-record',w:2,l:0,ra:20,rf:0},
    {id:'better-ra',w:1,l:1,ra:2,rf:0},
    {id:'better-rf',w:1,l:1,ra:5,rf:9}
  ];
  assert.equal(sort(rows,'officialPoolRank',true).map(t=>t.id).join(','),
    'better-record,better-ra,better-rf,ours,a-tied');
});

test('Next Game leaves GameChanger links in the record column',()=>{
  const render=client('nextTeamNameHtml',{
    gameChangerLinkHtml:id=>`<a class="gc-team-link" href="/${id}">GC</a>`,
    gameChangerLocationHtml:(id,name)=>id==='ours' && name==='Example Team - Coach'
      ? '<span class="team-location">Coach · Example City, XX</span>' : ''
  });
  assert.equal(render('<a class="nxt-link">Example Team</a>', 'ours', 'Example Team - Coach'),
    '<span class="nxt-team-name-line"><a class="nxt-link">Example Team</a></span><span class="team-location">Coach · Example City, XX</span>');
  assert.match(source, /\.nxt-team-name-line\{display:block;\}/);
});

test('coach and GameChanger location share one escaped secondary line',()=>{
  const render=client('gameChangerLocationHtml',{
    GAMECHANGER_LOCATIONS:{ ours:{ city:'Example <City>', state:'XX' } },
    splitRosterName:client('splitRosterName'), MY_ID:'ours', AST_TEAM_NAME:'Example Team-Coach',
    historyEsc:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;')
  });
  assert.equal(render('ours', 'Example Team - Coach'), '<span class="team-location">Coach · Example &lt;City&gt;, XX</span>');
  assert.equal(render('ours', 'Example Team'), '<span class="team-location">Coach · Example &lt;City&gt;, XX</span>');
  assert.equal(render('missing', 'Example Opponents-Sample Coach'), '<span class="team-location">Sample Coach</span>');
  assert.equal(render('missing'), '');
});


test('Next Game renders both record columns and links only the GC record',()=>{
  const records=client('gameChangerRecordHtml',{
    GAMECHANGER_RECORDS:{ours:{win:24,loss:8,tie:1}},GAMECHANGER_TEAMS:{ours:'https://web.gc.com/teams/example'},
    gameChangerAppUrl:client('gameChangerAppUrl')
  });
  const name=client('nextTeamNameHtml',{gameChangerLocationHtml:()=>'',gameChangerLinkHtml:()=>{throw Error('obsolete inline GC logo');}});
  const render=client('nextTeamRowHtml',{
    teamRecords:{ours:{w:2,l:0,t:1}},jsArg:JSON.stringify,displayTeamName:String,historyEsc:String,
    teamBadgeHTML:()=>'<img class="nxt-logo">',nextTeamNameHtml:name,gameChangerRecordHtml:records
  });
  const row=render('ours','Our team');
  assert.match(row,/2–0–1/);assert.match(row,/nxt-gc-record.*href="https:\/\/web.gc.com\/teams\/example\/team"/s);
  assert.match(row,/24–8–1/);assert.doesNotMatch(row,/gc-team-link/);
  assert.match(render('ours','Our team',null,true),/proj./);
  assert.equal((render(null,'TBD').match(/—/g)||[]).length,2);
});
