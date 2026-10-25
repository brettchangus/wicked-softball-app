import test from 'node:test';
import assert from 'node:assert/strict';
import { teamSummary } from '../netlify/functions/lib/scouting-summary.ts';
import type { ScoutGame } from '../netlify/functions/lib/scouting-types.ts';
// [date, runs for, runs against, opponent class], newest first like a report's games.
const games=(rows:[string,number,number,'B'|'C'][])=>rows.map(([date,rf,ra,group])=>({date:'2026-'+date+'T18:00:00Z',rf,ra,level:{group,basis:'test',source:null,games:0,largeLosses:0,share:null}}) as Pick<ScoutGame,'date'|'rf'|'ra'|'level'>);
// Real results from three fall reports.
const exampleValley=games([['10-04',3,4,'B'],['10-04',9,4,'B'],['10-03',12,11,'B'],['10-03',9,3,'B'],['09-30',0,0,'C'],['09-20',4,9,'C'],['09-20',9,4,'B'],['09-19',2,4,'B'],['09-19',5,3,'C'],['09-19',0,12,'B'],['09-04',11,6,'C']]);
const exampleQueens=games([['10-14',7,5,'B'],['09-13',7,18,'C'],['09-12',3,9,'B'],['09-12',5,9,'B'],['09-12',12,11,'B']]);
const sanBruno=games([['10-11',2,9,'C'],['10-11',11,6,'C']]);
const norcal=(level:string,rank:number,rankOf:number)=>({level,rank,rankOf,source:'NorCal'});

test('a C-rated team that holds its own against B teams leads with that contrast',()=>{
  assert.equal(teamSummary(exampleValley,norcal('C',5,16)),
    'Rated C by NorCal (#5 of 16), but 4-3 against B teams, winning 3 of their last 4. 5 of 11 games were decided by 2 runs or less (2-2-1).');
  assert.equal(teamSummary(exampleQueens,norcal('C',9,28)),
    'Rated C by NorCal (#9 of 28), but 2-2 against B teams. Won both of their close games (7-5 and 12-11) but lost the other three by 4 or more.');
});
test('without a rating the summary still uses results by class',()=>{
  assert.equal(teamSummary(exampleValley,null),
    '4-3 against B teams, winning 3 of their last 4. 5 of 11 games were decided by 2 runs or less (2-2-1).');
  assert.equal(teamSummary(exampleQueens),
    'Lost their only game against a C team, 18-7. Won both of their close games (7-5 and 12-11) but lost the other three by 4 or more.');
});
test('a B-rated team losing to B teams, with most wins against C teams',()=>{
  const struggling=games([['10-10',2,9,'B'],['10-09',3,8,'B'],['10-08',10,2,'C'],['10-07',1,5,'B'],['10-06',9,1,'C'],['10-05',12,3,'C']]);
  assert.equal(teamSummary(struggling,norcal('B',20,30)),
    'Rated B by NorCal (#20 of 30), but 0-3 against B teams. Won 3 games by 8 or more runs.');
  // Unrated, the share of wins against C teams is the notable fact.
  assert.equal(teamSummary(struggling).split('. ')[0],'3 of their 3 wins came against C teams; 0-3 against B teams');
});
test('form observations: streaks and lopsided games',()=>{
  const hot=games([['10-10',9,1,'B'],['10-09',12,2,'B'],['10-08',6,3,'C'],['10-07',4,5,'B']]);
  assert.match(teamSummary(hot),/Won their last 3\.$/);
  const blowouts=games([['10-10',15,2,'C'],['10-09',2,4,'B'],['10-08',12,1,'C'],['10-07',6,5,'B'],['10-06',3,9,'B']]);
  assert.match(teamSummary(blowouts),/Won 2 games by 8 or more runs\.$/);
});
test('two or fewer games say there is too little to judge',()=>{
  assert.equal(teamSummary(sanBruno,null),'1-1 in 2 games, both against C teams. Too few games to judge.');
  assert.equal(teamSummary(sanBruno.slice(0,1)),'0-1 in 1 game, against a C team. Too few games to judge.');
  assert.equal(teamSummary([]),'');
});
test('a tournament-level rating without a rank is named by its source',()=>{
  assert.match(teamSummary(exampleValley,{level:'B',rank:null,rankOf:null,source:'the tournament'}),/^Rated B by the tournament and 4-3 against B teams/);
});
test('a Rec team holding its own against B teams gets the same contrast a C team does',()=>{
  const played=games([['10-04',6,2,'B'],['10-03',5,4,'B'],['09-27',1,7,'B']]);
  const rating=(level:string)=>({level,rank:null,rankOf:null,source:'the admin'});
  assert.match(teamSummary(played,rating('C')),/^Rated C by the admin, but 2-1 against B teams/);
  assert.match(teamSummary(played,rating('Rec')),/^Rated Rec by the admin, but 2-1 against B teams/);
});
