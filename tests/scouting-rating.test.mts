import { seedTestSite } from './helpers/site-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';
import { SCOUTING_METHOD_VERSION } from '../netlify/functions/lib/scouting-metrics.ts';
import type { SavedReport, ScoutGame } from '../netlify/functions/lib/scouting-types.ts';
installMemoryBlobStore();
const {starRating,sameTeamName,norcalFinishes,placementFinish}=await import('../netlify/functions/lib/scouting-rating.ts');
const {ensureScopedModel,readSeason,writeSeason,resolveContext,writeStructure,writeResults}=await import('../netlify/functions/lib/snapshot.js');
const {saveScoutingReport}=await import('../netlify/functions/lib/scouting-store.ts');
const {default:reader}=await import('../netlify/functions/scouting-report.ts');
type Game=Pick<ScoutGame,'date'|'rf'|'ra'|'level'>;
// [runs for, runs against, opponent class], newest first like a report's games.
const games=(rows:[number,number,'B'|'C'][]):Game[]=>rows.map(([rf,ra,group],i)=>({date:'2026-10-'+String(20-i).padStart(2,'0')+'T18:00:00Z',rf,ra,level:{group,basis:'test',source:null,games:0,largeLosses:0,share:null}}));
// Anonymous calibration samples exercise class caps and rating thresholds.
const exampleValley=games([[3,4,'B'],[9,4,'B'],[12,11,'B'],[9,3,'B'],[4,9,'C'],[9,4,'B'],[2,4,'B'],[5,3,'C'],[0,12,'B'],[11,6,'C']]);
const exampleQueens=games([[7,5,'B'],[7,18,'C'],[3,9,'B'],[5,9,'B'],[12,11,'B']]);
const wicked=games([[0,2,'B'],[12,0,'B'],[4,3,'B'],[13,1,'C'],[4,12,'B'],[13,1,'B'],[4,3,'C'],[12,0,'C']]);
const gold=(place:number)=>({event:'Example Cup',place,bracket:'Gold',top:true});

test('calibration: our team rates 2.5, C teams 2 and below',()=>{
  assert.equal(starRating(wicked,'B',[gold(3),gold(3)])?.stars,2.5);
  assert.equal(starRating(wicked,'B')?.stars,2.5);
  assert.equal(starRating(exampleValley,'C')?.stars,2);
  assert.equal(starRating(exampleQueens,'C')?.stars,1.5);
});
test('the reason states the record and the class-adjusted margin',()=>{
  assert.equal(starRating(exampleValley,'C')!.reasons[0],'6-4 since Sep 1, -0.3 runs per game adjusted for opponent class');
});
test('a top-bracket title sets a floor of 3.5, and 4 with only a couple of losses',()=>{
  const average=games([[5,4,'B'],[3,6,'B'],[7,5,'B'],[2,5,'B'],[6,4,'B'],[1,4,'B']]);
  assert.equal(starRating(average,'B',[gold(1)])?.stars,3.5);
  const dominant=games([[9,2,'B'],[8,3,'B'],[3,4,'B'],[10,0,'C'],[7,1,'B'],[6,2,'B']]);
  assert.equal(starRating(dominant,'B')?.stars,3,'very good results alone, without a title');
  assert.deepEqual(starRating(dominant,'B',[gold(1)]),{stars:4,reasons:['5-1 since Sep 1, +4.7 runs per game adjusted for opponent class','1st in Example Cup (Gold)']});
});
test('runner-up and semifinal finishes set 3 and 2.5; lower brackets set nothing',()=>{
  const weak=games([[1,9,'B'],[2,8,'B'],[3,6,'B'],[4,5,'C']]);
  assert.equal(starRating(weak,'B')?.stars,1.5);
  assert.equal(starRating(weak,'B',[gold(2)])?.stars,3);
  assert.equal(starRating(weak,'B',[gold(4)])?.stars,2.5);
  assert.equal(starRating(weak,'B',[{event:'Example Cup',place:1,bracket:'Silver',top:false}])?.stars,1.5);
});
test('a C team is capped at 2 stars, even with a title',()=>{
  const r=starRating(exampleValley,'C',[gold(1)])!;
  assert.equal(r.stars,2);assert.equal(r.reasons.at(-1),'Capped at 2 stars for a C team');
});
test('small samples shrink toward 2 stars; no evidence gives no rating',()=>{
  assert.equal(starRating(games([[15,0,'B']]),'B')?.stars,2.5);
  assert.equal(starRating([],'C')?.stars,1);
  assert.equal(starRating([],null),null);
});
test('a title with no games since Sep 1 sets 3.5, not 4',()=>{
  assert.equal(starRating([],'B',[gold(1)])?.stars,3.5);
});
test('team names match across tournaments only with the same team and coach',()=>{
  assert.ok(sameTeamName('Example Valley Club - Coach One','Example Valley Club 10U - Coach One'));
  assert.ok(sameTeamName('Example West Club - Coach Two','Example West Club - 10U (Coach Two)'));
  assert.ok(sameTeamName('Example Rebels Black - Coach Three','Example Rebels 10U Black - Coach Three'));
  assert.ok(sameTeamName('Example Black 10C - Sal','Example Black 10C - Sal 10U'));
  assert.ok(sameTeamName('Example Dream','[3] Example Dream'));
  assert.ok(!sameTeamName("Example Magic - O'Reilly",'Example Magic - Coach Five'));
  assert.ok(!sameTeamName('Example West Club - Coach Four','Example West Club - 10U (Coach Two)'));
  assert.ok(!sameTeamName('Mischief - Diego','Example Mischief 10C'));
  assert.ok(!sameTeamName('Example Gold 2016','Example Gold 2017'));
  // A class or a team number stays part of the name, so sister teams never match.
  assert.ok(!sameTeamName('Wicked 10B','Wicked 10C'));
  assert.ok(!sameTeamName('Example Black - Sal','Example Black 10C - Sal'));
  assert.ok(!sameTeamName('Lightning 12','Lightning 14'));
});
test('finishes from NorCal tournaments and bracket placements',()=>{
  // Only a single-class B (or better) NorCal event is top tier; a combined class may be silver.
  assert.deepEqual(norcalFinishes([{id:'1',short:'Redwood',class:'10-B/C',place:1},{id:'2',short:'Fall',class:'10-Open',place:null},{id:'3',short:'C Classic',class:'10-C',place:2},{id:'4',short:'B Classic',class:'10-B',place:1},{id:'5',short:'Ours',class:'10-B',place:2}],new Set(['5'])),
    [{event:'Redwood',place:1,bracket:null,top:false},{event:'C Classic',place:2,bracket:null,top:false},{event:'B Classic',place:1,bracket:null,top:true}]);
  assert.deepEqual(placementFinish({label:'Gold Bracket',place:'3rd Place'},'Example Cup'),{event:'Example Cup',place:3,bracket:'Gold',top:true});
  assert.deepEqual(placementFinish({label:'Silver Bracket',place:'1st Place'},'Example Cup'),{event:'Example Cup',place:1,bracket:'Silver',top:false});
  assert.equal(placementFinish({label:'Championship Bracket',place:'2nd Place'},'Swing')?.top,true);
  assert.equal(placementFinish(null,'Swing'),null);
  // NorCal: the structure names its top bracket; "Gold" is not top when a Premier bracket exists.
  assert.deepEqual(placementFinish({label:'10U - Gold Bracket',place:'1st Place'},'Field of Screams','10U - Gold'),{event:'Field of Screams',place:1,bracket:'Gold',top:true});
  assert.equal(placementFinish({label:'10U - Gold Bracket',place:'1st Place'},'Billie Sue','10U - Premier')?.top,false);
});
test('teamPlacement finds any team\'s NorCal bracket finish',async()=>{
  const {teamPlacement}=await import('../netlify/functions/lib/tm-placement.js');
  const structure={meta:{provider:'norcal'},brackets:[{label:'10U - Gold',level:'gold'}]};
  const results={bracketGames:{gold:[{gameNo:1,topId:'x',botId:'y',topScore:5,botScore:2,status:'completed',time:'1'},{gameNo:2,topId:'z',botId:'w',topScore:1,botScore:6,status:'completed',time:'2'},{gameNo:3,topId:'x',botId:'w',topScore:3,botScore:4,status:'completed',time:'3'}]}};
  assert.deepEqual(teamPlacement(structure,results,'w'),{label:'10U - Gold Bracket',emoji:'🏆',place:'1st Place'});
  assert.deepEqual(teamPlacement(structure,results,'x'),{label:'10U - Gold Bracket',emoji:'🏆',place:'2nd Place'});
  assert.equal(teamPlacement(structure,results,'nobody'),null);
});
test('the report endpoint counts a gold title from another AST/Tourney Machine tournament this season',async()=>{
  await seedTestSite();
  const season=await readSeason('team','season');
  const [current,past]=[season.featuredEventKey,Object.keys(season.events).find((k:string)=>k!==season.featuredEventKey)];
  season.events[current].config={gameChangerTeams:{opp:'https://web.gc.com/teams/oppgc'}};
  await writeSeason(season);
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:current}) as any;
  const old=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:past}) as any;
  await writeStructure(ctx.eventId,{meta:{providerTeamId:'me'},pools:{A:{teams:[{id:'me',name:'Me'},{id:'opp',name:'Example Valley Club - Coach One',level:'B'}],games:[]}},brackets:[]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{},bracketGames:{}},ctx.scope);
  // A finished Tourney Machine gold final the same team (by team + coach name) won.
  await writeStructure(old.eventId,{meta:{provider:'tourneymachine',name:'Example Cup',providerTeamId:'me'},pools:{A:{teams:[{id:'h1',name:'Example Valley Club 10U - Coach One'},{id:'h2',name:'Example Gold'}],games:[]}},
    brackets:[{label:'Gold / Silver championship',topologyKnown:true,placementGames:{gold:'B4',silver:'B8'},frame:[{key:'B4',gameNo:4,topGame:3,botGame:2}]}]},old.scope);
  await writeResults(old.eventId,{games:{},standings:{},bracketGames:{championship:[{key:'B4',gameNo:4,topId:'h1',botId:'h2',topScore:6,botScore:2,status:'completed',time:'2026-10-11T14:00:00'}]}},old.scope);
  // Saved games in the collection (views are rebuilt from them on read), including a 0-0 left on
  // the schedule whose box score shows nobody batting.
  const line=(AB:number)=>[{id:'p1',name:'Player',number:'1',stats:{AB,BB:0},positions:[]}];
  const game=(id:string,date:string,rf:number,ra:number,group:'B'|'C',AB=20)=>({id,date,opponent:'Team '+id,opponentId:null,opponentPublicId:null,rf,ra,source:'',kind:'competitive',innings:[],
    hitters:line(AB),pitchers:[],warnings:[],boxScore:true,level:{group,basis:'test',source:null,games:0,largeLosses:0,share:null}});
  const played=[game('g1','2026-10-12T18:00:00Z',6,2,'B'),game('g2','2026-10-05T18:00:00Z',5,4,'B'),game('g3','2026-09-28T18:00:00Z',3,5,'B'),game('g4','2026-09-21T18:00:00Z',8,1,'C')];
  const report={opponent:{id:'opp',name:'Example Valley Club',role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-15T00:00:00Z',refreshedAt:null,asOf:'2026-10-15T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,
    sourceUrl:'https://web.gc.com/teams/oppgc',sourceFingerprint:'test',collection:{publicId:'oppgc',name:'Example Valley',season:'Fall 2026',games:[...played,game('g0','2026-09-30T07:00:00Z',0,0,'C',0)],warnings:[],collectedAt:'2026-10-15T00:00:00Z'},
    views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]} as unknown as SavedReport;
  await saveScoutingReport(ctx.scope,report);
  const res=await reader(new Request('http://localhost/api/scouting-report?team='+ctx.teamKey+'&season='+ctx.seasonKey+'&opponent=opp'));
  assert.equal(res.status,200);
  const {stars,views,warnings,norcal}=(await res.json()).report;
  assert.equal(stars.stars,4);
  // A Tourney Machine opponent with no NorCal team gets no badge or NorCal link.
  assert.equal(norcal,null);
  assert.deepEqual(stars.reasons,['3-1 since Sep 1, +1.8 runs per game adjusted for opponent class (few games)','1st in Example Cup (Gold)']);
  // The unplayed 0-0 is out of the record and named in the scorebook notes.
  assert.deepEqual([views.All.season.w,views.All.season.l,views.All.season.t],[3,1,0]);
  assert.deepEqual(warnings,['Sep 30 vs Team g0: listed as 0-0 but nobody batted in the box score, so it is not counted as a game.']);
});
test('a 0-0 counts as played only when its box score shows someone batting or pitching',async()=>{
  const {wasPlayed}=await import('../netlify/functions/lib/scouting-metrics.ts');
  const g=(rf:number,ra:number,boxScore:boolean,AB=0,BF=0)=>({rf,ra,boxScore,hitters:[{id:'a',name:'A',number:'',stats:{AB,BB:0,HBP:null},positions:[]}],pitchers:BF?[{id:'b',name:'B',number:'',stats:{BF},positions:[]}]:[]});
  assert.equal(wasPlayed(g(0,0,true)),false,'lineup only');
  assert.equal(wasPlayed(g(0,0,true,18)),true,'a real scoreless tie');
  assert.equal(wasPlayed(g(0,0,true,0,15)),true);
  assert.equal(wasPlayed(g(0,0,false)),false,'no box score to tell');
  assert.equal(wasPlayed(g(3,2,false)),true);
});
test('in a NorCal tournament, the opponent\'s own NorCal id wins over a conflicting name match',async()=>{
  const season=await readSeason('team','season');
  const current=season.featuredEventKey,other=Object.keys(season.events).filter((k:string)=>k!==current)[1];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:current}) as any;
  const old=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:other}) as any;
  await writeStructure(ctx.eventId,{meta:{provider:'norcal',eventId:'E1',providerTeamId:'me'},pools:{A:{teams:[{id:'me',name:'Me'},{id:'nc1',name:'Example Queens - Mancias',level:'B'}],games:[]}},brackets:[]},ctx.scope);
  // Another NorCal tournament this season lists a team with the same name under a different id.
  await writeStructure(old.eventId,{meta:{provider:'norcal',eventId:'E2',providerTeamId:'me'},pools:{A:{teams:[{id:'nc2',name:'Example Queens - Mancias'}],games:[]}},brackets:[]},old.scope);
  await writeResults(old.eventId,{games:{},standings:{},bracketGames:{}},old.scope);
  const asked:string[]=[];const original=globalThis.fetch;
  globalThis.fetch=(async(url:string)=>{asked.push(String(url));return Response.json({info:{teamClass:'10-B'},apex:{},results:[{id:'E9',shortName:'B Classic',class:'10-B',record:'4-0',place:1,dates:'Sep 12 - 13, 2026'}]});}) as any;
  try{
    const report={opponent:{id:'nc1',name:'Example Queens',role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-15T00:00:00Z',refreshedAt:null,asOf:'2026-10-15T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,
      sourceUrl:'https://web.gc.com/teams/dqgc',sourceFingerprint:'test',collection:{publicId:'dqgc',name:'Example Queens',season:'Fall 2026',games:[],warnings:[],collectedAt:'2026-10-15T00:00:00Z'},
      views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]} as unknown as SavedReport;
    // A link the stale check accepts.
    const s2=await readSeason('team','season');s2.events[current].config={gameChangerTeams:{nc1:'https://web.gc.com/teams/dqgc'}};await writeSeason(s2);
    await saveScoutingReport(ctx.scope,report);
    const res=await reader(new Request('http://localhost/api/scouting-report?team='+ctx.teamKey+'&season='+ctx.seasonKey+'&opponent=nc1'));
    assert.equal(res.status,200);
    const {stars,norcal}=(await res.json()).report;
    assert.ok(asked.some(u=>u.endsWith('/Team/nc1')),'asked NorCal for the tournament\'s own id');
    // The header's badge and NorCal link follow the same id.
    assert.deepEqual(norcal,{url:'https://norcal.registerplay.com/pages/team/detail/nc1',level:'10B'});
    assert.ok(!asked.some(u=>u.endsWith('/Team/nc2')));
    // No games since Sep 1, so the B-class title sets 3.5, not 4.
    assert.deepEqual(stars,{stars:3.5,reasons:['1st in B Classic']});
  }finally{globalThis.fetch=original;}
});
test('teamPlacement counts a NorCal win as 1st place only in the bracket final',async()=>{
  const {teamPlacement}=await import('../netlify/functions/lib/tm-placement.js');
  // A 6-team frame: 1 and 2 feed 3 and 4 (with byes), 3 and 4 feed the final, 5.
  const frame=[{gameNo:1},{gameNo:2},{gameNo:3,topGame:1},{gameNo:4,topGame:2},{gameNo:5,topGame:3,botGame:4}];
  const structure={meta:{provider:'norcal'},brackets:[{label:'10U - Gold',level:'gold',size:6,frame}]};
  const done=(gameNo:number,topId:string,botId:string,topScore:number,botScore:number,time:string)=>({key:'k'+gameNo,gameNo,topId,botId,topScore,botScore,status:'completed',time});
  // Quarterfinal won, semifinal not listed yet: still playing, not a title.
  assert.equal(teamPlacement(structure,{bracketGames:{gold:[done(1,'a','b',6,2,'1')]}},'a'),null);
  const all={bracketGames:{gold:[done(1,'a','b',6,2,'1'),done(2,'c','d',1,3,'2'),done(3,'a','e',5,4,'3'),done(4,'d','f',2,7,'4'),done(5,'a','f',3,1,'5')]}};
  assert.equal(teamPlacement(structure,all,'a')?.place,'1st Place');
  assert.equal(teamPlacement(structure,all,'f')?.place,'2nd Place');
  // Lost a game that feeds the final (game 3), even though it isn't numbered final-1.
  assert.equal(teamPlacement(structure,all,'e')?.place,'3rd Place');
  // An admin override of the final's score decides the finish.
  assert.equal(teamPlacement(structure,all,'f',{k5:{topScore:1,botScore:3,status:'completed'}})?.place,'1st Place');
});
test('NorCal class spellings with a U or no dash still count as single-class B',()=>{
  assert.deepEqual(norcalFinishes([{id:'1',short:'A',class:'10U-B',place:1},{id:'2',short:'B',class:'10B',place:1},{id:'3',short:'C',class:'10U B/C',place:1}]).map(f=>f.top),[true,true,false]);
});
test('structureTeams includes teams placed straight into a bracket, once each',async()=>{
  const {structureTeams}=await import('../netlify/functions/lib/scouting-rating.ts');
  const teams=structureTeams({pools:{A:{teams:[{id:'1',name:'One'}]}},brackets:[{teams:[{id:'1',name:'One'},{id:'2',name:'Two'}]},{teams:[{id:'3',name:'Three'}]}]});
  assert.deepEqual(teams.map((t:any)=>t.id),['1','2','3']);
  assert.deepEqual(structureTeams(null),[]);
});
test('a scheduled NorCal tournament with no captured results still counts from NorCal\'s own list',async()=>{
  const {seasonFinishes}=await import('../netlify/functions/lib/scouting-rating.ts');
  const season=await readSeason('team','season');
  const other=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[2];
  const old=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:other}) as any;
  // A past NorCal tournament with its structure but no results (only the featured event is polled).
  await writeStructure(old.eventId,{meta:{provider:'norcal',eventId:'E7'},pools:{},brackets:[{label:'10U - Gold',level:'gold',teams:[{id:'nc7',name:'Lady Outlaws - Lee'}]}]},old.scope);
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-B'},apex:{},results:[{id:'E7',shortName:'Outlaw Classic',class:'10-B',record:'4-0',place:1,dates:'Sep 12 - 13, 2026'}]})) as any;
  try{
    const ctx={scope:old.scope,eventKey:'not-in-season',season};
    const finishes=await seasonFinishes(ctx,{id:'x7',name:'Lady Outlaws - Lee',sourceUrl:'https://web.gc.com/teams/lo7'},null,'2026-10-15T00:00:00Z');
    assert.deepEqual(finishes,[{event:'Outlaw Classic',place:1,bracket:null,top:true}]);
  }finally{globalThis.fetch=original;}
});
test('a failed NorCal lookup is not cached',async()=>{
  const {seasonFinishes}=await import('../netlify/functions/lib/scouting-rating.ts');
  const ctx={scope:{teamKey:'t',seasonKey:'s',eventKey:'e'},eventKey:'e',season:{events:{}}};
  const opponent={id:'nc8',name:'Team Eight',sourceUrl:'https://web.gc.com/teams/t8'};
  const current={meta:{provider:'norcal'}};
  const original=globalThis.fetch;
  try{
    globalThis.fetch=(async()=>{throw new Error('offline');}) as any;
    assert.deepEqual(await seasonFinishes(ctx,opponent,current,'2026-10-15T00:00:00Z'),[]);
    globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-B'},apex:{},results:[{id:'E8',shortName:'Eight Cup',class:'10-B',record:'3-0',place:2,dates:'Sep 26 - 27, 2026'}]})) as any;
    assert.deepEqual(await seasonFinishes(ctx,opponent,current,'2026-10-15T00:00:00Z'),[{event:'Eight Cup',place:2,bracket:null,top:true}]);
  }finally{globalThis.fetch=original;}
});
test('a saved pregame report counts only finishes decided before its cutoff',async()=>{
  const {seasonFinishes,norcalFinishes:finishesOf}=await import('../netlify/functions/lib/scouting-rating.ts');
  const t=[{id:'1',shortName:'x',short:'Early',class:'10-B',place:1,dates:'Sep 12 - 13, 2026'},{id:'2',short:'Late',class:'10-B',place:1,dates:'Oct 17 - 18, 2026'},{id:'3',short:'Unknown',class:'10-B',place:1,dates:'TBD'}];
  // Ended before the cutoff only; a tournament with unreadable dates is left out.
  assert.deepEqual(finishesOf(t,new Set(),'2026-10-16T17:00:00Z').map(f=>f.event),['Early']);
  assert.deepEqual(finishesOf(t).map(f=>f.event),['Early','Late','Unknown']);
  // A Tourney Machine title decided after the report's as-of time doesn't count; before it, it does.
  const season=await readSeason('team','season');
  const key=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[3];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  await writeStructure(ctx.eventId,{meta:{provider:'tourneymachine',name:'Late Cup'},pools:{A:{teams:[{id:'h9',name:'Late Team - Coach'},{id:'h8',name:'Other'}],games:[]}},
    brackets:[{label:'Gold / Silver championship',topologyKnown:true,placementGames:{gold:'B4',silver:'B8'},frame:[{key:'B4',gameNo:4,topGame:3,botGame:2}]}]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{},bracketGames:{championship:[{key:'B4',gameNo:4,topId:'h9',botId:'h8',topScore:6,botScore:2,status:'completed',time:'2026-10-18T14:00:00'}]}},ctx.scope);
  const lookup={scope:ctx.scope,eventKey:'not-in-season',season};
  const opponent={id:'x9',name:'Late Team - Coach',sourceUrl:'https://web.gc.com/teams/late9'};
  assert.deepEqual(await seasonFinishes(lookup,opponent,null,'2026-10-16T17:00:00Z'),[]);
  assert.deepEqual((await seasonFinishes(lookup,opponent,null,'2026-10-19T17:00:00Z')).map(f=>f.event),['Late Cup']);
});
test('a same-named team with a different NorCal id lends no bracket finish',async()=>{
  const {seasonFinishes}=await import('../netlify/functions/lib/scouting-rating.ts');
  const season=await readSeason('team','season');
  const key=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[4];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  // Another NorCal tournament where a different team (other id) with our opponent's name won gold.
  await writeStructure(ctx.eventId,{meta:{provider:'norcal',name:'Gold Cup',eventId:'E5'},pools:{},brackets:[{label:'10U - Gold',level:'gold',frame:[{gameNo:1}],teams:[{id:'impostor',name:'Twin Team - Coach'},{id:'other',name:'Other'}]}]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{},bracketGames:{gold:[{key:'g1',gameNo:1,topId:'impostor',botId:'other',topScore:5,botScore:1,status:'completed',time:'2026-09-20T12:00:00'}]}},ctx.scope);
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-B'},apex:{},results:[]})) as any;
  try{
    // The current NorCal tournament vouches for id 'real'.
    const finishes=await seasonFinishes({scope:ctx.scope,eventKey:'current',season},{id:'real',name:'Twin Team - Coach',sourceUrl:'https://web.gc.com/teams/twin'},{meta:{provider:'norcal'}},'2026-10-15T00:00:00Z');
    assert.deepEqual(finishes,[]);
  }finally{globalThis.fetch=original;}
});
test('the dashboard placement mirror matches the server on a double-elimination bracket',async()=>{
  const fs=await import('node:fs');const {teamPlacement}=await import('../netlify/functions/lib/tm-placement.js');
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const start=html.indexOf('function wickedBracketPlacement(');const end=html.indexOf('\n}\n',start)+2;
  const snap={meta:{provider:'norcal'},brackets:[{level:'10b',label:'Example',size:4,frame:[
    {gameNo:36,topGame:34,botGame:35},{gameNo:-37,topGame:-36,botGame:33},{gameNo:38,topGame:36,botGame:37}]}],
    bracketGames:{'10b':[{gameNo:36,topId:'a',botId:'b',topScore:5,botScore:2,status:'completed',time:'2026-10-01T12:00:00'},
    {gameNo:-37,topId:'c',botId:'d',topScore:3,botScore:1,status:'completed',time:'2026-10-01T13:00:00'}]}};
  const bracket=snap.brackets.find((b:any)=>b.level==='10b'),games=snap.bracketGames['10b'];
  const ids=[...new Set(games.flatMap((g:any)=>[g.topId,g.botId]).filter(Boolean))] as string[];
  for(const id of ids){
    const mirror=new Function('MY_ID','ACTIVE_PROVIDER','BRACKETS','tourneyMachinePlacement',html.slice(start,end)+'\nreturn wickedBracketPlacement;')(id,'norcal',snap.brackets,()=>null);
    const mine=games.filter((g:any)=>g.topId===id||g.botId===id);
    const last=mine.reduce((a:any,b:any)=>(a.time||'')>(b.time||'')?a:b);
    assert.equal(mirror(games,last,bracket)?.place??null,teamPlacement(snap,snap,id)?.place??null,'team '+id);
  }
  // Game 36 (the winners' final) is not the final: its winner and loser are both still playing.
  const g36=games.find((g:any)=>Math.abs(g.gameNo)===36)!;
  assert.equal(teamPlacement(snap,snap,g36.topId),null);assert.equal(teamPlacement(snap,snap,g36.botId),null);
});
test('a bracket run with a game of unknown time never counts toward a pregame report',async()=>{
  const {seasonFinishes}=await import('../netlify/functions/lib/scouting-rating.ts');
  const season=await readSeason('team','season');
  const key=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[5];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  await writeStructure(ctx.eventId,{meta:{provider:'tourneymachine',name:'Timeless Cup'},pools:{A:{teams:[{id:'h7',name:'Timeless - Coach'},{id:'h6',name:'Other'}],games:[]}},
    brackets:[{label:'Gold / Silver championship',topologyKnown:true,placementGames:{gold:'B4',silver:'B8'},frame:[{key:'B4',gameNo:4,topGame:3,botGame:2}]}]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{},bracketGames:{championship:[{key:'B4',gameNo:4,topId:'h7',botId:'h6',topScore:6,botScore:2,status:'completed',time:''}]}},ctx.scope);
  const finishes=await seasonFinishes({scope:ctx.scope,eventKey:'not-in-season',season},{id:'x6',name:'Timeless - Coach',sourceUrl:'https://web.gc.com/teams/tl6'},null,'2026-10-15T00:00:00Z');
  assert.deepEqual(finishes,[]);
});
test('two conflicting trusted NorCal ids lend no NorCal bracket finish',async()=>{
  const {seasonScouting}=await import('../netlify/functions/lib/scouting-rating.ts');
  const season=await readSeason('team','season');
  const key=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[4];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  // A past NorCal tournament where the team under the saved identity's (older) id won gold.
  await writeStructure(ctx.eventId,{meta:{provider:'norcal',name:'Gold Cup',eventId:'E6'},pools:{},brackets:[{label:'10U - Gold',level:'gold',frame:[{gameNo:1}],teams:[{id:'111',name:'Split Team - Coach'},{id:'other',name:'Other'}]}]},ctx.scope);
  await writeResults(ctx.eventId,{games:{},standings:{},bracketGames:{gold:[{key:'g1',gameNo:1,topId:'111',botId:'other',topScore:5,botScore:1,status:'completed',time:'2026-09-20T12:00:00'}]}},ctx.scope);
  // The current NorCal tournament says 'newId'; a saved class identity points at 'oldId'.
  const conflicted={...season,teamConfig:{scoutingIdentities:{splitgc:{level:'B',basis:'Provider classification',source:'https://norcal.registerplay.com/pages/team/detail/111'}}}};
  const asked:string[]=[];const original=globalThis.fetch;
  globalThis.fetch=(async(url:string)=>{asked.push(String(url));return Response.json({info:{teamClass:'10-C'},apex:{},results:[]});}) as any;
  try{
    const {finishes,norcal}=await seasonScouting({scope:ctx.scope,eventKey:'current',season:conflicted},{id:'222',name:'Split Team - Coach',sourceUrl:'https://web.gc.com/teams/splitgc'},{meta:{provider:'norcal'}},'2026-10-15T00:00:00Z');
    assert.deepEqual(finishes,[]);
    // The report header still names the tournament's own NorCal team, and only it is asked.
    assert.deepEqual(norcal,{id:'222',level:'10C'});
    assert.ok(asked.every(u=>u.endsWith('/Team/222')));
  }finally{globalThis.fetch=original;}
});
test('the header\'s NorCal team needs a GameChanger link match, not just a name match',async()=>{
  const {seasonScouting}=await import('../netlify/functions/lib/scouting-rating.ts');
  const season=await readSeason('team','season');
  const key=Object.keys(season.events).filter((k:string)=>k!==season.featuredEventKey)[3];
  const ctx=await resolveContext({teamKey:season.teamKey,seasonKey:season.key,eventKey:key}) as any;
  await writeStructure(ctx.eventId,{meta:{provider:'norcal',name:'Name Cup',eventId:'E10'},pools:{A:{teams:[{id:'nc10',name:'Same Name - Coach'}],games:[]}},brackets:[]},ctx.scope);
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-Rec'},apex:{},results:[]})) as any;
  try{
    const opponent={id:'tm10',name:'Same Name - Coach',sourceUrl:'https://web.gc.com/teams/same10'};
    const byName=await seasonScouting({scope:ctx.scope,eventKey:'tm-current',season},opponent,null,'2026-10-15T00:00:00Z');
    assert.equal(byName.norcal,null,'a name match alone names no NorCal team');
    const linkedSeason={...season,events:{...season.events,[key]:{...season.events[key],config:{gameChangerTeams:{nc10:'https://web.gc.com/teams/same10'}}}}};
    const byLink=await seasonScouting({scope:ctx.scope,eventKey:'tm-current',season:linkedSeason},{...opponent,name:'Renamed'},null,'2026-10-15T00:00:00Z');
    assert.deepEqual(byLink.norcal,{id:'nc10',level:'10 Rec'});
  }finally{globalThis.fetch=original;}
});
test('NorCal\'s current class sets the stars and summary, so they agree with the badge',async()=>{
  const {presentScoutingReport}=await import('../netlify/functions/lib/scouting-reports.ts');
  const ctx={scope:{teamKey:'t',seasonKey:'s',eventKey:'live'},eventKey:'live',season:{events:{}}};
  const structure={meta:{provider:'norcal'},pools:{A:{teams:[{id:'lc1',name:'Live Class - Coach',level:'B'}],games:[]}},brackets:[]};
  const report={rating:{level:'B',rank:4,rankOf:40,source:'NorCal'},opponent:{id:'lc1',name:'Live Class',role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-15T00:00:00Z',refreshedAt:null,asOf:'2026-10-15T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,
    sourceUrl:'https://web.gc.com/teams/lc1gc',sourceFingerprint:'test',collection:{publicId:'lc1gc',name:'Live Class',season:'Fall 2026',games:[],warnings:[],collectedAt:'2026-10-15T00:00:00Z'},
    views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]} as unknown as SavedReport;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-B'},apex:{teamClass:'10-C'},results:[]})) as any;
  try{
    const shown=await presentScoutingReport(ctx,report,structure) as any;
    assert.equal(shown.norcal.level,'10C');
    assert.equal(shown.rating.level,'C');
  }finally{globalThis.fetch=original;}
  // NorCal's "10 Rec" is a class too (not C, though it ends in a c): it replaces the saved B, keeps
  // NorCal's rank, and an admin Rec only repeats it, so it is no override.
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-Rec'},apex:{},results:[]})) as any;
  try{
    const shown=await presentScoutingReport({...ctx,scope:{...ctx.scope,eventKey:'rec'},eventKey:'rec'},report,structure) as any;
    assert.equal(shown.norcal.level,'10 Rec');
    assert.deepEqual(shown.rating,{level:'Rec',rank:4,rankOf:40,source:'NorCal'});
    const agreed=await presentScoutingReport({...ctx,scope:{...ctx.scope,eventKey:'rec2'},eventKey:'rec2',event:{config:{opponents:{lc1:{level:'Rec'}}}}},report,structure) as any;
    assert.deepEqual(agreed.rating,{level:'Rec',rank:4,rankOf:40,source:'NorCal'},'the admin Rec keeps NorCal\'s rank');
  }finally{globalThis.fetch=original;}
});
test('a scouted team is rated by its NorCal class, not the pool it plays in, and an admin class that agrees changes nothing',async()=>{
  const {presentScoutingReport}=await import('../netlify/functions/lib/scouting-reports.ts');
  const report=(rating:any)=>({rating,opponent:{id:'up1',name:'Playing Up',role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-15T00:00:00Z',refreshedAt:null,asOf:'2026-10-15T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,
    sourceUrl:'https://web.gc.com/teams/up1gc',sourceFingerprint:'test',collection:{publicId:'up1gc',name:'Playing Up',season:'Fall 2026',games:[],warnings:[],collectedAt:'2026-10-15T00:00:00Z'},
    views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]}) as unknown as SavedReport;
  // A C team playing in this tournament's B pool.
  const structure={meta:{provider:'tourneymachine'},pools:{A:{teams:[{id:'up1',name:'Playing Up',level:'B',norcalClass:'C'}],games:[]}},brackets:[]};
  const ctx={scope:{teamKey:'t',seasonKey:'s',eventKey:'up'},eventKey:'up',season:{events:{}},event:{config:{}}};
  const older=await presentScoutingReport(ctx,report({level:'B',rank:null,rankOf:null,source:'the tournament'}),structure) as any;
  assert.deepEqual(older.rating,{level:'C',rank:null,rankOf:null,source:'NorCal'},'a rating saved from the pool gives way');
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-C'},apex:{teamClass:'10-C'},results:[]})) as any;
  try{
    const agreed=await presentScoutingReport({...ctx,eventKey:'up2',scope:{...ctx.scope,eventKey:'up2'},event:{config:{opponents:{up1:{level:'C'}}}}},
      report({level:'C',rank:9,rankOf:28,source:'NorCal'}),{...structure,meta:{provider:'norcal'}}) as any;
    assert.deepEqual(agreed.rating,{level:'C',rank:9,rankOf:28,source:'NorCal'},'NorCal\'s rating and rank stay');
  }finally{globalThis.fetch=original;}
});
test('a class set in Opponents wins for the stars and summary and regroups games against that team',async()=>{
  const {presentScoutingReport}=await import('../netlify/functions/lib/scouting-reports.ts');
  const ctx={scope:{teamKey:'t',seasonKey:'s',eventKey:'set'},eventKey:'set',season:{events:{}},
    event:{config:{opponents:{lc1:{level:'Rec'},op2:{level:'C'},op3:{level:'B'}}}}};
  const structure={meta:{provider:'norcal'},pools:{A:{teams:[{id:'lc1',name:'Live Class - Coach',level:'B'},{id:'op2',name:'Two'},{id:'op3',name:'Three'}],games:[]}},brackets:[]};
  const level=(group:'B'|'C',extra={})=>({group,basis:'Provider classification',source:null,games:0,largeLosses:0,share:null,...extra});
  const game=(id:string,teamId:string|null,lvl:any)=>({id,date:'2026-10-01T17:00:00Z',opponent:id,opponentId:null,opponentPublicId:null,opponentTeamId:teamId,rf:5,ra:3,source:'gc',kind:'competitive',innings:[],hitters:[],pitchers:[],warnings:[],boxScore:false,level:lvl});
  const report={rating:{level:'B',rank:4,rankOf:40,source:'NorCal'},opponent:{id:'lc1',name:'Live Class',role:'Confirmed opponent',gameKeys:[],firstPitch:null},generatedAt:'2026-10-15T00:00:00Z',refreshedAt:null,asOf:'2026-10-15T00:00:00Z',methodVersion:SCOUTING_METHOD_VERSION,
    sourceUrl:'https://web.gc.com/teams/lc1gc',sourceFingerprint:'test',collection:{publicId:'lc1gc',name:'Live Class',season:'Fall 2026',
      games:[game('g2','op2',level('B')),game('g3','op3',level('C',{basis:'Coach classification',reviewedAt:'2026-10-02T00:00:00Z'})),game('g4',null,level('B'))],warnings:[],collectedAt:'2026-10-15T00:00:00Z'},
    views:{},history:{scope:'test',meetings:[],warnings:[]},warnings:[]} as unknown as SavedReport;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({info:{teamClass:'10-B'},apex:{teamClass:'10-B'},results:[]})) as any;
  try{
    const shown=await presentScoutingReport(ctx,report,structure) as any;
    assert.deepEqual(shown.rating,{level:'Rec',rank:null,rankOf:null,source:'the admin'},'beats NorCal\'s class');
    assert.match(shown.summary||'',/^Rated Rec by the admin/);
    const groups=Object.fromEntries(shown.collection.games.map((g:any)=>[g.id,[g.level.group,g.level.reason||null]]));
    assert.deepEqual(groups.g2,['C','Set in Opponents']);
    assert.deepEqual(groups.g3,['C',null],'the report\'s own coach classification wins');
    assert.deepEqual(groups.g4,['B',null],'a team outside this tournament keeps its class');
    assert.deepEqual(shown.views.C.games.map((g:any)=>g.id),['g2','g3']);
    assert.equal(report.collection.games[0].level!.group,'B','the saved report is not changed');
  }finally{globalThis.fetch=original;}
});
