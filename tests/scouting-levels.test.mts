import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOpponentClasses,classificationKey,classifyCompetition,competitionClassInput,knownOpponentPublicId,matchCompetitionTeam,scoutingAge } from '../netlify/functions/lib/scouting-levels.ts';
import type { Level, ScoutGame } from '../netlify/functions/lib/scouting-types.ts';
const result=(rf:number,ra:number)=>({rf,ra,kind:'competitive'} as ScoutGame);
test('exactly one quarter of games lost by 8+ qualifies as likely C',()=>{
  const games=[result(0,8),result(1,0),result(1,0),result(1,0)];
  assert.equal(classifyCompetition({games}).group,'C');assert.equal(classifyCompetition({games}).share,.25);
});
test('below 25% is performance-based B; missing classification and zero games default to B',()=>{
  const below=classifyCompetition({games:[result(0,8),...Array.from({length:4},()=>result(1,0))]});
  assert.equal(below.group,'B');assert.equal(below.basis,'Likely B');
  assert.equal(classifyCompetition({games:[result(0,8),result(1,0),result(1,0),result(1,0)]}).basis,'Likely C');
  const missing=classifyCompetition({});assert.equal(missing.basis,'B by default');assert.equal(missing.share,null);
});
test('fewer than 3 games default to B even when every game was a large loss',()=>{
  const two=classifyCompetition({games:[result(0,8),result(0,10)]});
  assert.equal(two.group,'B');assert.equal(two.basis,'B by default');assert.equal(two.share,1);
  assert.equal(classifyCompetition({games:[result(0,8),result(0,10),result(0,9)]}).basis,'Likely C');
  assert.equal(classifyCompetition({games:[result(1,0),result(1,0),result(1,0)]}).basis,'Likely B');
});
test('explicit B and coach override win over the fallback',()=>{
  const games=[result(0,20)];assert.equal(classifyCompetition({level:'B',games}).group,'B');assert.equal(classifyCompetition({override:'C',level:'B',games:[]}).group,'C');
});
test('unplayed/excluded games do not dilute large-loss denominator',()=>{
  assert.equal(classifyCompetition({games:[result(0,8),{...result(2,0),kind:'excluded'}]}).share,1);
});
test('ambiguous GameChanger link cannot transfer provider classification',()=>{
  const teams=[{id:'1',level:'C'},{id:'2',level:'B'}],links={'1':'https://web.gc.com/teams/id','2':'https://web.gc.com/teams/id'};
  assert.equal(matchCompetitionTeam('id',links,teams),null);assert.equal(matchCompetitionTeam('id',{'1':links['1']},teams)?.level,'C');
});
test('identity checks use the tournament age before the team Age setting',()=>{
  const team={agePrefix:'10U'};
  assert.equal(scoutingAge({discovery:{detected:{age:11},manual:{age:'12'}}},team,'10B'),'12');
  assert.equal(scoutingAge({discovery:{detected:{age:11}}},team,'10B'),'11');
  assert.equal(scoutingAge({},team,'12B'),'10');
  assert.equal(scoutingAge(null,{},'10B'),'10');
  assert.equal(scoutingAge(null,null,null),null);
});
test('a scorebook id is never replaced by a name match',()=>{
  const links={t1:'https://web.gc.com/teams/linked1',t2:'https://web.gc.com/teams/linked2'};
  const own={name:'Wicked 10B',publicId:'ours'};
  assert.equal(knownOpponentPublicId({opponent:'Wicked 10B',opponentPublicId:'other-wicked'},{own,links,candidateNames:{}}),'other-wicked');
  assert.equal(knownOpponentPublicId({opponent:'Wicked 10B',opponentPublicId:null},{own,links,candidateNames:{}}),'ours');
  assert.equal(knownOpponentPublicId({opponent:'Hawks',opponentPublicId:null},{own,links,candidateNames:{t1:'Hawks'}}),'linked1');
  assert.equal(knownOpponentPublicId({opponent:'Hawks',opponentPublicId:null},{own,links,candidateNames:{t1:'Hawks',t2:'Hawks'}}),null);
});
test('two teams sharing a display name get separate classification keys',()=>{
  assert.notEqual(classificationKey('one','Bay Thunder'),classificationKey('two','Bay Thunder'));
  assert.equal(classificationKey(null,'Bay Thunder'),classificationKey(null,'Bay Thunder'));
  assert.notEqual(classificationKey(null,'Bay Thunder'),classificationKey('Bay Thunder','x'));
});
test('an Opponents class regroups games against that team; Rec counts with C',()=>{
  const level:Level={group:'B',basis:'Likely B',source:null,games:4,largeLosses:0,share:0};
  const games=[{opponentTeamId:'a',level},{opponentTeamId:'b',level},{opponentTeamId:'c',level},{opponentTeamId:null,level}];
  const shown=applyOpponentClasses(games,{a:'C',b:'Rec',c:'Gold'});
  assert.deepEqual(shown.map(g=>g.level.group),['C','C','B','B']);
  assert.equal(shown[1].level.reason,'Rec, set in Opponents (counted with C)');
  assert.equal(shown[0].level.basis,'Coach classification');
  assert.equal(shown[2],games[2],'an unknown class leaves the game alone');
});
test('a tournament team\'s NorCal class wins over the pool it plays in, labeled by its real source',()=>{
  assert.deepEqual(competitionClassInput({level:'B',norcalClass:'C'}),{norcalLevel:'C'});
  assert.deepEqual(competitionClassInput({level:'B',norcalClass:'C'},'10-Rec'),{norcalLevel:'C'},'the live standings class, Rec counted with C');
  assert.deepEqual(competitionClassInput({level:'B',registeredLevel:'C'}),{registeredLevel:'C'},'registration is labeled as registration');
  assert.deepEqual(competitionClassInput({level:'B'}),{level:'B'});
  assert.deepEqual(competitionClassInput({registeredLevel:'A',level:'B'}),{},'an A team has a class but no B/C group');
  assert.deepEqual(competitionClassInput(null),{});
  const shown=classifyCompetition({...competitionClassInput({level:'B',norcalClass:'C'}),games:[]});
  assert.deepEqual([shown.group,shown.basis],['C','NorCal classification']);
  assert.equal(classifyCompetition({...competitionClassInput({level:'B',registeredLevel:'C'}),games:[]}).basis,'Provider registration');
  assert.equal(classifyCompetition({override:'B',norcalLevel:'C',games:[]}).basis,'Coach classification');
  assert.equal(classifyCompetition({level:'B',registeredLevel:'C',games:[]}).basis,'Provider classification');
});
