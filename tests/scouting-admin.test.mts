import { seedTestSite } from './helpers/site-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';
import { SCOUTING_METHOD_VERSION } from '../netlify/functions/lib/scouting-metrics.ts';
import type { SavedReport,Scope } from '../netlify/functions/lib/scouting-types.ts';
process.env.ADMIN_SECRET='scouting-test';
const stores=installMemoryBlobStore() as any;
const {default:admin}=await import('../netlify/functions/admin.js');
const {ensureScopedModel,readSeason,writeSeason,resolveContext,writeStructure,writeResults}=await import('../netlify/functions/lib/snapshot.js');
const {saveScoutingReport,readScoutingReport,listScoutingReports,scoutingIndexKey}=await import('../netlify/functions/lib/scouting-store.ts');
const {default:reader}=await import('../netlify/functions/scouting-report.ts');
const post=(body:any)=>admin(new Request('http://localhost/admin?key=scouting-test',{method:'POST',body:JSON.stringify(body)}));
async function setup(){
  await seedTestSite();
  const season=await readSeason('team','season');
  season.status='active';
  const key=season.featuredEventKey;
  season.events[key].config={gameChangerTeams:{future:'https://web.gc.com/teams/future',past:'https://web.gc.com/teams/past'}};
  await writeSeason(season);
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  const future=new Date(Date.now()+86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
  await writeStructure(ctx.eventId,{meta:{providerTeamId:'me'},pools:{A:{teams:[{id:'me',name:'Me'},{id:'future',name:'Future'},{id:'past',name:'Past'}],games:[{key:'next',hid:'me',aid:'future',an:'Future',t:future},{key:'old',hid:'me',aid:'past',an:'Past',t:past}]}},brackets:[]},ctx.scope);
  await writeResults(ctx.eventId,{games:{old:{status:'completed'}},standings:{},bracketGames:{}},ctx.scope);
  return ctx;
}
const saved=(id:string):SavedReport=>({opponent:{id,name:id,role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-01T00:00:00Z',refreshedAt:null,asOf:'2026-10-01T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,sourceUrl:'https://web.gc.com/teams/'+id,sourceFingerprint:'test',collection:{publicId:id,name:id,season:'Fall 2026',games:[],warnings:[],collectedAt:'2026-10-01T00:00:00Z'},views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]});
test('missing and expired tokens return the shared prompt error contract without changing saved reports',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));
  let res=await post({...ctx.scope,action:'refreshScoutingReport',opponentId:'future'});
  assert.equal(res.status,503);assert.equal((await res.json()).code,'gameChangerToken');
  const original=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:401});
  try{res=await post({...ctx.scope,action:'refreshScoutingReport',opponentId:'future',gcToken:'secret-never-stored'});assert.equal((await res.json()).code,'gameChangerToken');}
  finally{globalThis.fetch=original;}
  assert.equal((await readScoutingReport(ctx.scope,'future'))?.refreshedAt,null);
  assert.ok(![...stores.get('tournament').values()].some((v:any)=>String(v).includes('secret-never-stored')));
});
test('refresh-all does not touch a past report and generation skips an existing report',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));await saveScoutingReport(ctx.scope,saved('past'));
  const before=JSON.stringify(await readScoutingReport(ctx.scope,'past'));
  const res=await post({...ctx.scope,action:'refreshScoutingReports',opponentId:'past',gcToken:'test'});
  assert.deepEqual((await res.json()).completed,[]);assert.equal(JSON.stringify(await readScoutingReport(ctx.scope,'past')),before);
  const generated=await post({...ctx.scope,action:'generateScoutingReports',gcToken:'test'});
  assert.deepEqual((await generated.json()).completed,[]);
});
test('delete is scoped to the selected tournament and makes only that report missing',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));
  const other:Scope={...ctx.scope,eventKey:'other'};await saveScoutingReport(other,saved('future'));
  const res=await post({...ctx.scope,action:'deleteScoutingReport',opponentId:'future'});
  assert.equal(res.status,200);assert.equal(await readScoutingReport(ctx.scope,'future'),null);assert.ok(await readScoutingReport(other,'future'));
  const state=await post({...ctx.scope,action:'getScoutingReports'});assert.ok((await state.json()).opponents.some((o:any)=>o.id==='future'));
});
test('reader serves saved reports only and rejects a corrected GameChanger identity',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));
  const query=new URLSearchParams({team:ctx.teamKey,season:ctx.seasonKey,eventKey:ctx.eventKey,opponent:'future'});
  assert.equal((await reader(new Request('http://localhost/api/scouting-report?'+query))).status,200);
  const season=await readSeason(ctx.teamKey,ctx.seasonKey);season.events[ctx.eventKey].config.gameChangerTeams.future='https://web.gc.com/teams/corrected';await writeSeason(season);
  assert.equal((await reader(new Request('http://localhost/api/scouting-report?'+query))).status,409);
});
test('saving a refreshed report preserves the original date and stores a frozen version',async()=>{
  const ctx=await setup();const first=saved('future');await saveScoutingReport(ctx.scope,first);
  await saveScoutingReport(ctx.scope,{...first,refreshedAt:'2026-10-14T00:00:00Z'});
  const summaries=await listScoutingReports(ctx.scope);assert.equal(summaries.find(r=>r.id==='future')?.generatedAt,first.generatedAt);
  assert.ok([...stores.get('tournament').keys()].filter((key:any)=>key.includes(ctx.eventKey+':scouting:future:version:')).length>=2);
});
test('coach corrections require a verified saved identity and invalidate older reports',async()=>{
  const ctx=await setup();const report=saved('future');
  report.collection.games=[{id:'test-game',date:'2026-10-01T00:00:00Z',opponent:'Other 10U',opponentId:null,opponentPublicId:'other-public',rf:2,ra:0,kind:'competitive',source:'test',innings:[],boxScore:false,hitters:[],pitchers:[],warnings:[]}];
  await saveScoutingReport(ctx.scope,report);
  let res=await post({...ctx.scope,action:'setScoutingIdentity',opponentId:'future',publicId:'not-known',level:'C',reason:'Coach verified'});
  assert.equal(res.status,400);
  res=await post({...ctx.scope,action:'setScoutingIdentity',opponentId:'future',publicId:'other-public',level:'C',reason:'Coach verified current 10U roster'});
  assert.equal(res.status,200);
  const query=new URLSearchParams({team:ctx.teamKey,season:ctx.seasonKey,eventKey:ctx.eventKey,opponent:'future'});
  assert.equal((await reader(new Request('http://localhost/api/scouting-report?'+query))).status,409);
  const state=await post({...ctx.scope,action:'getScoutingReports'});assert.equal((await state.json()).reports.find((r:any)=>r.id==='future').stale,true);
});
test('a refresh that loses all player-box access preserves the usable report and dates',async()=>{
  const ctx=await setup();const report=saved('future');
  report.collection.games=[{id:'old',date:'2026-10-01T00:00:00Z',opponent:'Other',opponentId:null,opponentPublicId:null,rf:2,ra:0,kind:'competitive',source:'test',innings:[],boxScore:true,hitters:[],pitchers:[],warnings:[]}];
  await saveScoutingReport(ctx.scope,report);
  const before=JSON.stringify(await readScoutingReport(ctx.scope,'future')),original=globalThis.fetch;
  globalThis.fetch=async(input:any)=>{
    const url=String(input);
    if(url.endsWith('/public/teams/future'))return Response.json({id:'future',name:'Future'});
    if(url.endsWith('/public/teams/future/games'))return Response.json([{id:'game',start_ts:'2026-10-10T18:00:00Z',score:{team:2,opponent_team:0},opponent_team:{name:'Other'},game_status:'completed'}]);
    if(url.includes('/details'))return Response.json({id:'game',line_score:{team:{scores:[2,0]}}});
    return new Response('{}',{status:403});
  };
  try{
    const result=await (await post({...ctx.scope,action:'refreshScoutingReport',opponentId:'future',gcToken:'test'})).json();
    assert.equal(result.completed.length,0);assert.match(result.failed[0].error,/previous report was kept/);
  }finally{globalThis.fetch=original;}
  assert.equal(JSON.stringify(await readScoutingReport(ctx.scope,'future')),before);
});

test('reports using the old game limits require refresh before displaying the new date range',async()=>{
  const ctx=await setup();const old=saved('future');old.methodVersion=1;await saveScoutingReport(ctx.scope,old);
  const query=new URLSearchParams({team:ctx.teamKey,season:ctx.seasonKey,eventKey:ctx.eventKey,opponent:'future'});
  assert.equal((await reader(new Request('http://localhost/api/scouting-report?'+query))).status,409);
  const state=await post({...ctx.scope,action:'getScoutingReports'});assert.equal((await state.json()).reports.find((r:any)=>r.id==='future').stale,true);
});

test('the snapshot list reads one index record instead of downloading each report',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));await saveScoutingReport(ctx.scope,saved('past'));
  stores.operations.length=0;
  const summaries=await listScoutingReports(ctx.scope);
  assert.ok(['future','past'].every(id=>summaries.some(r=>r.id===id)));
  const reads=stores.operations.filter((op:any)=>op.store==='tournament');
  assert.deepEqual(reads.map((op:any)=>op.operation+' '+(op.key||op.prefix)),['get '+scoutingIndexKey(ctx.scope)]);
});
test('reports saved before the index existed stay listed, and the admin view rebuilds the index',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));
  stores.get('tournament').delete(scoutingIndexKey(ctx.scope));
  assert.ok((await listScoutingReports(ctx.scope)).some(r=>r.id==='future'));
  await post({...ctx.scope,action:'getScoutingReports'});
  assert.ok(JSON.parse(stores.get('tournament').get(scoutingIndexKey(ctx.scope))).summaries.future);
});
test('deleting a report removes it from the snapshot list',async()=>{
  const ctx=await setup();await saveScoutingReport(ctx.scope,saved('future'));
  await post({...ctx.scope,action:'deleteScoutingReport',opponentId:'future'});
  assert.ok(!(await listScoutingReports(ctx.scope)).some(r=>r.id==='future'));
});
test('a corrected GameChanger link marks the report as needing refresh in admin',async()=>{
  const ctx=await setup();
  // Earlier tests may leave a class revision on the shared season; match it so only the link differs.
  const current=(await readSeason(ctx.teamKey,ctx.seasonKey)).teamConfig?.scoutingIdentityRev||null;
  await saveScoutingReport(ctx.scope,{...saved('future'),levelRevision:current});
  let state=await (await post({...ctx.scope,action:'getScoutingReports'})).json();
  assert.equal(state.reports.find((r:any)=>r.id==='future').stale,false);
  const season=await readSeason(ctx.teamKey,ctx.seasonKey);season.events[ctx.eventKey].config.gameChangerTeams.future='https://web.gc.com/teams/corrected';await writeSeason(season);
  state=await (await post({...ctx.scope,action:'getScoutingReports'})).json();
  assert.equal(state.reports.find((r:any)=>r.id==='future').stale,true);
});

test('a game whose opponent is found only by the name search keeps its tournament team for the Opponents class',async()=>{
  const ctx=await setup();
  const date=new Date(Date.now()-2*86400000).toISOString();
  const month=Number(date.slice(5,7)),season=month<=5?'spring':month<=8?'summer':'fall';
  const original=globalThis.fetch;
  globalThis.fetch=async(input:any)=>{
    const url=String(input);
    // GameChanger's name search: one confident hit, the team linked to `past` in Opponents.
    if(url.includes('/search'))return Response.json({hits:[{type:'team',result:{public_id:'past',name:'Past Typed 10U',season:{name:season,year:Number(date.slice(0,4))},location:{state:'CA'}}}]});
    if(/\/public\/teams\/(future|past)$/.test(url))return Response.json({id:url.split('/').pop(),name:'Team'});
    // The scorebook names the opponent by hand: no GameChanger id, and not the saved link's name.
    if(url.endsWith('/public/teams/future/games'))return Response.json([{id:'typed',start_ts:date,score:{team:3,opponent_team:2},opponent_team:{name:'Past Typed'},game_status:'completed'}]);
    if(url.endsWith('/public/teams/past/games'))return Response.json([]);
    return new Response('{}',{status:403});
  };
  try{
    await saveScoutingReport(ctx.scope,saved('future'));
    const body=await (await post({...ctx.scope,action:'refreshScoutingReport',opponentId:'future',gcToken:'test'})).json();
    assert.equal(body.completed?.length,1,JSON.stringify(body));
  }finally{globalThis.fetch=original;}
  const game=(await readScoutingReport(ctx.scope,'future'))!.collection.games.find(g=>g.id==='typed')!;
  assert.deepEqual([game.opponentPublicId,game.opponentTeamId],['past','past']);
  // So a class set for `past` in Opponents reaches the game when the report is read.
  const season2=await readSeason(ctx.teamKey,ctx.seasonKey);
  season2.events[ctx.eventKey].config={...season2.events[ctx.eventKey].config,opponents:{past:{level:'C'}}};
  await writeSeason(season2);
  const query=new URLSearchParams({team:ctx.teamKey,season:ctx.seasonKey,eventKey:ctx.eventKey,opponent:'future'});
  const shown=await (await reader(new Request('http://localhost/api/scouting-report?'+query))).json();
  assert.deepEqual(shown.report.collection.games.find((g:any)=>g.id==='typed').level.group,'C');
});

test('the public report and the admin view resolve classes from the same snapshot, standings included',async()=>{
  const ctx=await setup();
  const future=new Date(Date.now()+86400000).toISOString();
  // NorCal's setup class says B; the posted standings now say C, so the calculated class is C.
  await writeStructure(ctx.eventId,{meta:{providerTeamId:'me'},pools:{A:{teams:[{id:'me',name:'Me'},{id:'future',name:'Future',norcalClass:'B'}],
    games:[{key:'next',hid:'me',aid:'future',an:'Future',t:future}]}},brackets:[]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{A:[{teamID:'future',team:'Future',record:'0-0',class:'10C'}]},bracketGames:{}},ctx.scope);
  // The admin set B, which differs from the calculated C, so it is a real override.
  const season=await readSeason(ctx.teamKey,ctx.seasonKey);
  season.events[ctx.eventKey].config={...season.events[ctx.eventKey].config,opponents:{future:{level:'B'}}};
  await writeSeason(season);
  await saveScoutingReport(ctx.scope,{...saved('future'),levelRevision:season.teamConfig?.scoutingIdentityRev||null});
  const query=new URLSearchParams({team:ctx.teamKey,season:ctx.seasonKey,eventKey:ctx.eventKey,opponent:'future'});
  const pubBody=await (await reader(new Request('http://localhost/api/scouting-report?'+query))).json();
  const admBody=await (await post({...ctx.scope,action:'viewScoutingReport',opponentId:'future'})).json();
  const pub=pubBody.report,adm=admBody.report;
  assert.deepEqual(adm.rating,{level:'B',rank:null,rankOf:null,source:'the admin'});
  assert.deepEqual(pub.rating,adm.rating,'the public report matches the admin view');
});


test('report generation keeps the pool pregame cutoff and persists its season window',async()=>{
  const ctx=await setup();
  ctx.season={...ctx.season,name:'Fall 2027'};
  const snap={meta:{providerTeamId:'me'},pools:{A:{teams:[{id:'me',name:'Me'},{id:'future',name:'Future'}],games:[
    {key:'next',hid:'me',aid:'future',an:'Future',time:'2027-10-18T09:00:00'},
  ]}},brackets:[]};
  const {scoutingOpponents}=await import('../netlify/functions/lib/scouting-opponents.ts');
  const {buildScoutingReport,presentScoutingReport}=await import('../netlify/functions/lib/scouting-reports.ts');
  const now='2027-10-18T20:00:00Z';
  const opponent=scoutingOpponents(snap,Date.parse(now)).opponents[0];
  const original=globalThis.fetch;
  globalThis.fetch=async(input:any)=>{
    const url=String(input);
    if(url.endsWith('/public/teams/future'))return Response.json({id:'future',name:'Future',team_season:{season:'fall',year:2027}});
    if(url.endsWith('/public/teams/future/games'))return Response.json([
      ['old','2027-08-31T19:00:00Z'],['before','2027-10-17T19:00:00Z'],['after','2027-10-18T17:00:00Z'],
    ].map(([id,date])=>({id,start_ts:date,score:{team:2,opponent_team:1},opponent_team:{name:'Other',public_id:'other'},game_status:'completed'})));
    return new Response('{}',{status:403});
  };
  try{
    const report=await buildScoutingReport(ctx,snap,opponent,'test',null,now);
    assert.equal(report.asOf,'2027-10-18T16:00:00.000Z');
    assert.equal(report.startDate,'2027-09-01T00:00:00-07:00');
    await saveScoutingReport(ctx.scope,report);
    assert.equal((await readScoutingReport(ctx.scope,'future'))?.startDate,report.startDate);
    // A later dashboard season edit must not change a saved report's window on read.
    ctx.season.name='Fall 2028';
    const shown=await presentScoutingReport(ctx,report,null);
    assert.deepEqual(shown.views.All.games.map(g=>g.id),['before']);
    assert.equal(shown.views.All.startDate,report.startDate);
  }finally{globalThis.fetch=original;}
});
