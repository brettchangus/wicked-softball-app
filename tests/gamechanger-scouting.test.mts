import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, parseBoxScore, inningsToOuts, collectGameChanger } from '../netlify/functions/lib/gamechanger-scouting.ts';
import { searchGameChangerTeams } from '../netlify/functions/lib/gamechanger-search.js';
import { playerMetrics } from '../netlify/functions/lib/scouting-metrics.ts';
const schedule=[{id:'game-1',start_ts:'2026-10-11T18:00:00Z',game_status:'completed',opponent_team:{name:'Other'},score:{team:2,opponent_team:0}}];
const game=()=>parseSchedule(schedule,'public','2026-10-14T00:00:00Z')[0];
const box=()=>({public:{players:[{id:'p',first_name:'Sample',last_name:'Hitter',number:'12'}],groups:[{category:'lineup',stats:[{player_id:'p',stats:{AB:2,H:1,R:2,BB:1,SO:0}}],team_stats:{R:2,H:1},extra:[]},{category:'pitching',stats:[{player_id:'p',stats:{IP:4.2,H:0,R:0,BB:0,SO:7}}],team_stats:{R:0},extra:[{stat_name:'BF',stats:[{player_id:'p',value:15}]}]}]},other:{players:[],groups:[{category:'lineup',stats:[],team_stats:{R:0}}]}});
test('posted schedule games are deduplicated, completed and before cutoff',()=>{
  assert.equal(parseSchedule([...schedule,...schedule,{...schedule[0],id:'future',start_ts:'2026-10-15T00:00:00Z'}],'public','2026-10-14T00:00:00Z').length,1);
});
test('baseball innings notation is stored as outs',()=>{assert.equal(inningsToOuts('4.2'),14);assert.equal(inningsToOuts('4.3'),null);assert.equal(inningsToOuts(null),null);});
test('GameChanger decimal thirds convert to exact outs without rounding arbitrary fractions',()=>{
  for(const [ip,outs] of [[1/3,1],[2/3,2],[7/3,7],[8/3,8],[14/3,14]])assert.equal(inningsToOuts(ip),outs);
  assert.equal(inningsToOuts('2.6666666666666665'),8);
  for(const ip of [2.67,-1,NaN,Infinity,'',undefined])assert.equal(inningsToOuts(ip),null);
});

test('fractional source innings remain available in normalized pitcher lines',()=>{
  const raw:any=box();raw.public.groups[1].stats[0].stats.IP=8/3;
  const result=parseBoxScore(raw,game(),'public');
  assert.equal(result.pitchers[0].stats.OUTS,8);
  const games=[8/3,1,2].map((ip,i)=>{const boxScore:any=box();boxScore.public.groups[1].stats[0].stats.IP=ip;return parseBoxScore(boxScore,{...game(),id:'game-'+i},'public');});
  assert.equal(playerMetrics(games,'pitchers',3)[0].metrics.outs,17);
});

test('authenticated raw team/group box score maps players and BF',()=>{
  const result=parseBoxScore(box(),game(),'public');
  assert.equal(result.boxScore,true);assert.equal(result.hitters[0].name,'Sample Hitter');assert.equal(result.pitchers[0].stats.BF,15);assert.equal(result.pitchers[0].stats.OUTS,14);
});
test('sparse returned extras distinguish zero counts from an unavailable extra group',()=>{
  assert.equal(parseBoxScore(box(),game(),'public').hitters[0].stats.HBP,0);
  const raw:any=box();delete raw.public.groups[0].extra;
  assert.equal(parseBoxScore(raw,game(),'public').hitters[0].stats.HBP,undefined);
});
test('mismatched team totals keep reported player stats and verified game results',()=>{
  const raw=box();raw.public.groups[0].team_stats.R=3;
  const result=parseBoxScore(raw,game(),'public');assert.equal(result.boxScore,true);assert.equal(result.hitters.length,1);assert.equal(result.hitters[0].stats.R,2);assert.equal(result.rf,2);assert.match(result.warnings[0],/differ/);
});
test('HTML preview shape is never treated as a real box score',()=>assert.throws(()=>parseBoxScore({preview:true,players:[]},game(),'public'),/unavailable/));
test('expired token is distinguishable and is never included in an error',async()=>{
  const fake=async()=>new Response('{}',{status:401});
  await assert.rejects(collectGameChanger('https://web.gc.com/teams/public','private-test-token',{fetchImpl:fake as typeof fetch}),e=>(e as any).code==='gameChangerToken'&&!String(e).includes('private-test-token'));
});
test('collection uses verified route shapes and preserves permissions gaps',async()=>{
  const paths:string[]=[];
  const fake=async(url:any)=>{paths.push(String(url));return Response.json(String(url).endsWith('/games')?schedule:String(url).endsWith('/public/teams/public')?{id:'public',name:'Team'}:String(url).includes('/details')?{id:'game-1',line_score:{team:{scores:[2,0]}}}:box());};
  const result=await collectGameChanger('https://web.gc.com/teams/public','test',{fetchImpl:fake as typeof fetch,cutoff:'2026-10-14T00:00:00Z'});
  assert.equal(result.games[0].boxScore,true);assert.deepEqual(result.games[0].innings,[2,0]);assert.ok(paths.some(p=>p.endsWith('/game-stream-processing/game-1/boxscore')));
});
test('punctuation-free search still verifies both coaches and rejects the wrong roster',async()=>{
  const fake=async(_url:any,request:any)=>{
    assert.equal(JSON.parse(request.body).name,'Outlaws Hill');
    return Response.json({hits:[{type:'team',result:{public_id:'correct',name:'Outlaws Hill/Batchelder 10U',season:{name:'fall',year:2026},location:{city:'Benicia',state:'CA'}}},{type:'team',result:{public_id:'wrong',name:'Outlaws Other 10U',season:{name:'fall',year:2026},location:{city:'Benicia',state:'CA'}}}]});
  };
  const candidates=await searchGameChangerTeams('Outlaws Hill/Batchelder 10U',{query:'Outlaws Hill',age:'10U',date:'2026-10-14',token:'test'},fake as typeof fetch) as {autoMatch:boolean;url:string}[];
  assert.deepEqual(candidates.filter(c=>c.autoMatch).map(c=>c.url),['https://web.gc.com/teams/correct']);
});
test('fall team-season matching includes its August games rather than searching summer teams',async()=>{
  const fake=async(_url:any,request:any)=>{
    assert.deepEqual(JSON.parse(request.body).seasons,[{name:'fall',year:2026}]);
    return Response.json({hits:[{type:'team',result:{public_id:'fall-id',name:'Example 10U',season:{name:'fall',year:2026},location:{city:'Example',state:'CA'}}}]});
  };
  const candidates=await searchGameChangerTeams('Example 10U',{age:'10U',date:'2026-08-30',season:'fall',year:2026,token:'test'},fake as typeof fetch) as {autoMatch:boolean}[];
  assert.equal(candidates[0].autoMatch,true);
});

test('collection imports every box score in the report period without the old ten-game cap',async()=>{
  const rows=Array.from({length:12},(_,i)=>({...schedule[0],id:'sept-'+i,start_ts:'2026-09-'+String(i+1).padStart(2,'0')+'T18:00:00Z'}));
  rows.push({...schedule[0],id:'august',start_ts:'2026-08-30T18:00:00Z'});
  const imported:string[]=[];
  const fake=async(url:any)=>{
    const path=String(url);
    if(path.endsWith('/games'))return Response.json(rows);
    if(path.endsWith('/public/teams/public'))return Response.json({id:'public',name:'Team'});
    if(path.includes('/details'))return Response.json({id:/processing\/([^/]+)/.exec(path)?.[1]});
    imported.push(path);return Response.json(box());
  };
  const result=await collectGameChanger('https://web.gc.com/teams/public','test',{fetchImpl:fake as typeof fetch,cutoff:'2026-10-14T00:00:00Z',boxSince:'2026-09-01T00:00:00-07:00'});
  assert.equal(result.games.length,13);assert.equal(imported.length,12);
  assert.equal(result.games.filter(g=>g.boxScore).length,12);assert.equal(result.games.find(g=>g.id==='august')?.boxScore,false);
  assert.equal(result.warnings.length,0);
});

test('mismatched player runs do not erase reported runs or RBI',()=>{
  const raw:any=box();raw.public.groups[0].stats[0].stats.R=1;raw.public.groups[0].stats[0].stats.RBI=2;
  const result=parseBoxScore(raw,game(),'public');
  assert.equal(result.boxScore,true);assert.equal(result.hitters[0].stats.R,1);assert.equal(result.hitters[0].stats.RBI,2);
  const totals=playerMetrics([result],'hitters')[0].counts;
  assert.equal(totals.R,1);assert.equal(totals.RBI,2);assert.match(result.warnings.join(' '),/used as reported/);
});

test('other source count mismatches are notes rather than blanking available player stats',()=>{
  const raw:any=box();raw.public.groups[0].team_stats.H=3;
  raw.public.groups[0].stats[0].stats['2B']=2;
  raw.public.groups[0].extra=[{stat_name:'2B',stats:[{player_id:'p',value:2}]}];
  raw.public.groups[1].extra[0].stats[0].value=1;
  const result=parseBoxScore(raw,game(),'public');
  assert.equal(result.boxScore,true);assert.equal(result.hitters[0].stats.H,1);assert.equal(result.hitters[0].stats['2B'],2);
  assert.equal(result.pitchers[0].stats.SO,7);assert.equal(result.pitchers[0].stats.BF,1);
  assert.ok(result.warnings.some(w=>w.includes('team hits')));assert.ok(result.warnings.some(w=>w.includes('Extra-base')));
});
