import test from 'node:test';
import assert from 'node:assert/strict';
import { bracketGamesWithLive,scoutingOpponents,tournamentTimestamp } from '../netlify/functions/lib/scouting-opponents.ts';
const now=Date.parse('2026-10-17T00:00:00Z');
const game=(key:string,opp:string)=>({key,hid:'me',aid:opp,hn:'Me',an:opp,t:'2026-10-18T19:00:00Z'});
test('provider times without offsets use Pacific daylight and standard time',()=>{
  assert.equal(tournamentTimestamp('2026-10-17T12:00:00'),'2026-10-17T19:00:00.000Z');
  assert.equal(tournamentTimestamp('2026-12-05T12:00:00'),'2026-12-05T20:00:00.000Z');
  assert.equal(tournamentTimestamp('2026-10-17T19:00:00Z'),'2026-10-17T19:00:00.000Z');
});
test('completed-only opponents are excluded; scheduled rematches remain',()=>{
  const snap={meta:{providerTeamId:'me'},pools:{A:{games:[game('1','past'),game('2','again'),game('3','again')]}},results:{'1':{status:'completed'},'2':{status:'completed'}}};
  assert.deepEqual(scoutingOpponents(snap,now).opponents.map(o=>o.id),['again']);
});
test('published unassigned seed template is not a filled bracket',()=>{
  const snap={meta:{providerTeamId:'me'},brackets:[{level:'gold',frame:[{gameNo:1,key:'b1',topId:'me',botSeed:2,botName:'2nd Place'}]}]};
  assert.equal(scoutingOpponents(snap,now).bracketsSet,false);
});
test('filled bracket follows feeders and retains reachable rematches',()=>{
  const frame=[{gameNo:1,key:'b1',topId:'me',topName:'Me',botId:'old',botName:'Old',time:'2026-10-18T18:00:00Z'},{gameNo:2,key:'b2',topId:'a',topName:'A',botId:'b',botName:'B'},{gameNo:3,key:'b3',topGame:1,botGame:2}];
  const result=scoutingOpponents({meta:{providerTeamId:'me'},brackets:[{level:'gold',frame}]},now);
  assert.equal(result.bracketsSet,true);assert.deepEqual(new Set(result.opponents.map(o=>o.id)),new Set(['old','a','b']));
});
test('eliminated teams and an eliminated tracked team have no future bracket path',()=>{
  const frame=[{gameNo:1,key:'b1',topId:'me',botId:'a',topName:'Me',botName:'A'},{gameNo:2,key:'b2',topGame:1,botId:'b',botName:'B'}];
  const snap={meta:{providerTeamId:'me'},brackets:[{level:'gold',frame}],bracketGames:{gold:[{key:'b1',status:'completed',topScore:0,botScore:2}]}};
  assert.equal(scoutingOpponents(snap,now).opponents.length,0);
});
test('NorCal bracket frames without keys pick up live assignments by game number',()=>{
  // extractBracketFrame slots carry only gameNo; live games carry the key and the assignments.
  const frame=[{gameNo:1,topSeed:1,botSeed:2,time:'2026-10-18T19:00:00Z'},{gameNo:2,topGame:1,botId:'c',botName:'C'}];
  const live=[{key:'k1',gameNo:1,topId:'me',topName:'Me',botId:'other',botName:'Other',status:'yet2Play'},{key:'k2',gameNo:2,topId:null,botId:null}];
  const result=scoutingOpponents({meta:{providerTeamId:'me'},brackets:[{level:'gold',frame}],bracketGames:{gold:live}},now);
  assert.equal(result.bracketsSet,true);
  assert.deepEqual(new Set(result.opponents.map(o=>o.id)),new Set(['other','c']));
  assert.deepEqual(result.opponents.find(o=>o.id==='other')?.gameKeys,['k1']);
});
test('a manual result under the live key prunes an eliminated NorCal bracket opponent',()=>{
  const frame=[{gameNo:1,topSeed:1,botSeed:2},{gameNo:2,topGame:1,botId:'c',botName:'C'}];
  const live=[{key:'k1',gameNo:1,topId:'me',topName:'Me',botId:'other',botName:'Other'},{key:'k2',gameNo:2}];
  const snap={meta:{providerTeamId:'me'},brackets:[{level:'gold',frame}],bracketGames:{gold:live},results:{k1:{status:'completed',topScore:5,botScore:1}}};
  assert.deepEqual(scoutingOpponents(snap,now).opponents.map(o=>[o.id,o.gameKeys]),[['c',['k2']]]);
});
test('bracket slots join live games by key first and never lose a seeded team to a null live value',()=>{
  const joined=bracketGamesWithLive([{gameNo:7,key:'tm-7',topId:'a'},{gameNo:8,botId:'b'}],[{key:'tm-7',gameNo:99,botId:'x'},{key:'n-8',gameNo:8,botId:null,status:'live'}],{});
  assert.deepEqual(joined.map(g=>[g.key,g.topId??null,g.botId??null]),[['tm-7','a','x'],['n-8',null,'b']]);
  assert.equal(joined[1].status,'live');
});


test('provider pool timestamps preserve first pitch for both home and away opponents',()=>{
  const snap={meta:{providerTeamId:'me'},pools:{A:{games:[
    {key:'home',hid:'me',aid:'a',an:'A',time:'2026-10-18T09:00:00'},
    {key:'away',hid:'b',aid:'me',hn:'B',time:'2026-10-18T11:00:00'},
  ]}}};
  assert.deepEqual(scoutingOpponents(snap,now).opponents.map(o=>[o.id,o.firstPitch]),[
    ['a','2026-10-18T16:00:00.000Z'],['b','2026-10-18T18:00:00.000Z'],
  ]);
});

test('signed loser-bracket games resolve winner and loser feeds without hiding the bracket',()=>{
  const frame=[
    {gameNo:1,key:'b1',topId:'me',botId:'a',topName:'Me',botName:'A'},
    {gameNo:-2,key:'b2',topId:'b',botId:'c',topName:'B',botName:'C'},
    {gameNo:3,key:'b3',topGame:1,botGame:2},
    {gameNo:4,key:'b4',topGame:-1,botGame:-2},
  ];
  const snap={meta:{providerTeamId:'me'},brackets:[{level:'gold',frame}],bracketGames:{gold:[
    {key:'b2',gameNo:-2,status:'completed',topScore:5,botScore:1},
  ]}};
  const result=scoutingOpponents(snap,now);
  assert.equal(result.bracketsSet,true);
  assert.deepEqual(new Set(result.opponents.map(o=>o.id)),new Set(['a','b','c']));
  assert.deepEqual(result.opponents.find(o=>o.id==='b')?.gameKeys,['b3']);
  assert.deepEqual(result.opponents.find(o=>o.id==='c')?.gameKeys,['b4']);
});
