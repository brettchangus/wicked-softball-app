import test from 'node:test';
import assert from 'node:assert/strict';
import { scoutingMetrics,playerMetrics,perGameFloor,scoutingReportStaleReason,SCOUTING_METHOD_VERSION } from '../netlify/functions/lib/scouting-metrics.ts';
import type { ScoutGame } from '../netlify/functions/lib/scouting-types.ts';
const g=(id:string,group:'B'|'C',date='2026-10-11T00:00:00Z'):ScoutGame=>({id,date,opponent:'Other',opponentId:null,opponentPublicId:null,rf:group==='C'?15:2,ra:1,kind:'competitive',source:'test',innings:[],warnings:[],boxScore:true,hitters:[],pitchers:[],level:{group,basis:'test',source:null,games:0,largeLosses:0,share:null}});
test('all B games in the report period are included without a five-game limit',()=>{
  const games=[g('1','C'),g('2','C'),g('3','B'),g('4','B'),g('5','B'),g('6','B')];
  const view=scoutingMetrics(games,'B','2026-10-14T00:00:00Z');assert.equal(view.recent.games,4);assert.equal(view.recent.rfPerGame,2);assert.equal(view.season.games,4);
});
test('games before September 1 are excluded from all report statistics',()=>{
  const view=scoutingMetrics([g('old','B','2026-08-01T00:00:00Z')],'B','2026-10-14T00:00:00Z');assert.equal(view.recent.games,0);assert.equal(view.season.games,0);assert.equal(view.recent.rfPerGame,null);
});
test('averages combine raw counts, not individual game averages',()=>{
  const a=g('1','B'),b=g('2','B');
  a.hitters=[{id:'p',name:'Player',number:'1',stats:{AB:1,H:1,BB:0,SO:0},positions:[]}];
  b.hitters=[{...a.hitters[0],stats:{AB:3,H:0,BB:0,SO:1}}];
  const player=playerMetrics([a,b],'hitters')[0];assert.equal(player.metrics.avg,.25);assert.equal(player.metrics.obp,null);
});
test('hitters qualify when at-bats plus walks reach 1.5 times their games played',()=>{
  const games=Array.from({length:11},(_,i)=>g(String(i),'B'));
  // Spread a season line across 11 games (bar 16.5): stats on the first game, zero lines on the rest.
  const line=(id:string,AB:number,H:number,BB:number)=>games.forEach((game,i)=>{game.hitters.push({id,name:id,number:'',stats:i?{AB:0,H:0,BB:0,SO:0}:{AB,H,BB,SO:0},positions:[]});});
  line('short',12,8,4);   // 16 < 16.5: a .667 hitter who does not qualify
  line('walks',14,8,4);   // 18 >= 16.5: qualifies only because walks count
  line('atbats',17,9,0);  // 17 >= 16.5: on at-bats alone
  const byId=Object.fromEntries(playerMetrics(games,'hitters').map(p=>[p.id,p]));
  assert.equal(byId.short.qualified,false);assert.deepEqual(byId.short.badges,[]);
  assert.equal(byId.walks.qualified,true);assert.ok(byId.walks.badges.includes('Hitting .400+'));
  assert.equal(byId.atbats.qualified,true);assert.ok(byId.atbats.badges.includes('Hitting .400+'));
});
test('zero walks produce 0% with real BF and missing BF stays unavailable',()=>{
  const game=g('1','B');game.pitchers=[{id:'p',name:'Pitcher',number:'2',positions:[],stats:{BF:20,BB:0,SO:10,OUTS:12,H:2}}];
  assert.equal(playerMetrics([game],'pitchers')[0].metrics.bbRate,0);delete game.pitchers[0].stats.BF;assert.equal(playerMetrics([game],'pitchers')[0].metrics.kRate,null);
});

test('ERA uses aggregate earned runs and outs on a seven-inning basis',()=>{
  const a=g('1','B'),b=g('2','B');
  a.pitchers=[{id:'p',name:'Pitcher',number:'2',positions:[],stats:{ER:2,R:9,OUTS:8}}];
  b.pitchers=[{...a.pitchers[0],stats:{ER:0,R:1,OUTS:3}}];
  assert.equal(playerMetrics([a,b],'pitchers')[0].metrics.era,42/11);
  assert.equal(playerMetrics([b],'pitchers')[0].metrics.era,0);
  delete b.pitchers[0].stats.ER;
  assert.equal(playerMetrics([a,b],'pitchers')[0].metrics.era,null);
  b.pitchers[0].stats={ER:2,OUTS:0};
  assert.equal(playerMetrics([b],'pitchers')[0].metrics.era,null);
  b.pitchers[0].stats={ER:2,OUTS:null};
  assert.equal(playerMetrics([b],'pitchers')[0].metrics.era,null);
});

test('all appearances since September 1 count, beyond ten games and thirty days',()=>{
  const games=Array.from({length:12},(_,i)=>{
    const game=g(String(i),'B','2026-09-'+String(i+1).padStart(2,'0')+'T18:00:00Z');
    game.hitters=[{id:'b',name:'Batter',number:'1',positions:[],stats:{AB:2,H:1}}];
    game.pitchers=[{id:'p',name:'Pitcher',number:'2',positions:[],stats:{OUTS:3,BF:4,ER:1,SO:2,BB:1,H:0}}];
    return game;
  });
  const view=scoutingMetrics(games,'All','2026-10-14T00:00:00Z');
  assert.equal(view.recent.games,12);assert.equal(view.hitters[0].counts.AB,24);
  assert.equal(view.pitchers[0].games,12);assert.equal(view.pitchers[0].metrics.outs,36);
  assert.equal(view.coverage.recentBoxScores,12);assert.equal(view.tendencies.boxGames,12);
});

test('September 1 starts at Pacific midnight and future games remain excluded',()=>{
  const games=[g('before','B','2026-09-01T06:59:59Z'),g('start','B','2026-09-01T07:00:00Z'),g('after','B','2026-09-02T00:00:00Z'),g('cutoff','B','2026-10-14T00:00:00Z')];
  const view=scoutingMetrics(games,'All','2026-10-14T00:00:00Z');
  assert.deepEqual(view.games.map(g=>g.id),['after','start']);assert.equal(view.season.games,2);
});
test('one currency check covers method, GameChanger link and class revision',()=>{
  const report={id:'opp',methodVersion:SCOUTING_METHOD_VERSION,sourceUrl:'https://web.gc.com/teams/a',levelRevision:'rev1'};
  const links={opp:'https://web.gc.com/teams/a'};
  assert.equal(scoutingReportStaleReason(report,links,'rev1'),null);
  assert.equal(scoutingReportStaleReason({...report,methodVersion:1},links,'rev1'),'method');
  assert.equal(scoutingReportStaleReason(report,{opp:'https://web.gc.com/teams/corrected'},'rev1'),'link');
  assert.equal(scoutingReportStaleReason(report,{},'rev1'),'link');
  assert.equal(scoutingReportStaleReason(report,links,'rev2'),'classes');
  assert.equal(scoutingReportStaleReason({...report,levelRevision:null},links,undefined),null);
  // Without a tournament structure the link cannot be checked, so it is not reported as changed.
  assert.equal(scoutingReportStaleReason(report,null,'rev1'),null);
});
test('per-game count thresholds round up and never drop below their minimum',()=>{
  assert.deepEqual([perGameFloor(.6,5,3),perGameFloor(.6,11,3),perGameFloor(.6,2,3),perGameFloor(.6,10,3)],[3,7,3,6]);
  assert.deepEqual([perGameFloor(.25,11,2),perGameFloor(.25,5,2),perGameFloor(.25,8,2)],[3,2,2]);
});
// Spreads season lines over n games: each player's totals on the first game, zero lines after.
const season=(n:number,kind:'hitters'|'pitchers',lines:[string,Record<string,number>,number?][])=>{
  const games=Array.from({length:n},(_,i)=>g(String(i),'B',`2026-10-${String(10+i).padStart(2,'0')}T00:00:00Z`));
  for(const [id,stats,appearances=n] of lines)for(let i=0;i<appearances;i++){
    const zero=Object.fromEntries(Object.keys(stats).map(k=>[k,0]));
    games[i][kind].push({id,name:id,number:'',stats:i?zero:stats,positions:[]});
  }
  return games;
};
test('a short report highlights .400 hitters by hits per game, not a fixed eight',()=>{
  const games=season(5,'hitters',[['six',{AB:8,H:6,BB:1,SO:0}],['two',{AB:7,H:2,BB:1,SO:0}]]);
  const byId=Object.fromEntries(playerMetrics(games,'hitters').map(p=>[p.id,p]));
  assert.ok(byId.six.badges.includes('Hitting .400+'));   // 6 hits >= 3 in 5 games
  assert.deepEqual(byId.two.badges,[]);                    // .286
  const tiny=season(2,'hitters',[['perfect',{AB:2,H:2,BB:1,SO:0}]]);
  assert.deepEqual(playerMetrics(tiny,'hitters')[0].badges,[]); // 2 hits < minimum 3
});
test('extra-base production scales with games played',()=>{
  const games=season(5,'hitters',[['power',{AB:8,H:4,BB:0,SO:0,'2B':2,'3B':0,HR:0}],['single',{AB:8,H:4,BB:0,SO:0,'2B':1,'3B':0,HR:0}]]);
  const view=scoutingMetrics(games,'All','2026-10-30T00:00:00Z');
  assert.deepEqual(view.hitters.filter(p=>p.badges.includes('Extra-base production')).map(p=>p.id),['power']);
});
test('pitchers qualify by batters faced per team game and two appearances',()=>{
  // 5 team games: 20 BF needed.
  const games=season(5,'pitchers',[['starter',{BF:39,SO:10,BB:3,OUTS:30,H:5},4],['short',{BF:19,SO:6,BB:1,OUTS:12,H:2},3],['once',{BF:25,SO:9,BB:1,OUTS:15,H:2},1]]);
  const byId=Object.fromEntries(playerMetrics(games,'pitchers').map(p=>[p.id,p]));
  assert.equal(byId.starter.qualified,true);assert.equal(byId.short.qualified,false);assert.equal(byId.once.qualified,false);
});
test('pitcher leader badges need an absolute rate, so a weak staff gets none',()=>{
  const weak=season(5,'pitchers',[['a',{BF:39,SO:5,BB:20,OUTS:12,H:5},4],['b',{BF:38,SO:7,BB:12,OUTS:16,H:5},3]]);
  assert.ok(scoutingMetrics(weak,'All','2026-10-30T00:00:00Z').pitchers.every(p=>!p.badges.length));
  const strong=season(5,'pitchers',[['ace',{BF:40,SO:10,BB:4,OUTS:30,H:5},3],['b',{BF:38,SO:7,BB:12,OUTS:16,H:5},3]]);
  assert.deepEqual(scoutingMetrics(strong,'All','2026-10-30T00:00:00Z').pitchers.find(p=>p.id==='ace')?.badges,['Strikeout leader','Low walk rate']);
});


test('the September report window follows the year, including seasons before 2026',()=>{
  for(const year of [2025,2027]){
    const games=[g('august','B',year+'-09-01T06:59:59Z'),g('september','B',year+'-09-01T07:00:00Z')];
    const view=scoutingMetrics(games,'All',year+'-10-14T00:00:00Z');
    assert.deepEqual(view.games.map(game=>game.id),['september']);
    assert.equal(Date.parse(view.startDate),Date.parse(year+'-09-01T07:00:00Z'));
  }
});

test('spring reports use the preceding September in Pacific time',()=>{
  const games=[g('before','B','2026-09-01T06:59:59Z'),g('fall','B','2026-09-01T07:00:00Z'),g('spring','B','2027-03-01T19:00:00Z')];
  const view=scoutingMetrics(games,'All','2027-04-01T00:00:00Z');
  assert.deepEqual(view.games.map(game=>game.id),['spring','fall']);
  // At this UTC instant it is still August 31 in Pacific time.
  assert.equal(scoutingMetrics([],'All','2027-09-01T06:59:59Z').startDate,'2026-09-01T00:00:00-07:00');
});
