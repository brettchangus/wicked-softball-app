// Chat assistant context builders: team-agnostic templates (⟦TEAM⟧ sentinels), pending-schedule
// facts, and the season schedule block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installMemoryBlobStore } from './helpers/blob-store.mjs';
installMemoryBlobStore();
const { buildBracketFrameContext, buildBracketProjection, buildScheduleContext, buildSeasonScheduleContext, personalizeChatText } = await import('../netlify/functions/chat.js');

const pendingSnap = { meta:{ name:'Example Cup', dates:['2026-09-19','2026-09-20'], schedulePending:true, division:'10U',
  venue:{ name:'', city:'Example City' }, ast:{ region:'Example Region', location:'Example City', teams:['Opponent Elite-Coach', 'Example Team-Coach'] } },
  pools:{}, poolOrder:[], brackets:[] };

test('pending schedule context states what is and is not known, with our team details', () => {
  const text = personalizeChatText(buildScheduleContext(pendingSnap, { subtitle:'Example City, XX · Coach: Example Coach' }), 'Example Team');
  assert.match(text, /Our team is "Example Team" \(Example City, XX · Coach: Example Coach\)\./);
  assert.match(text, /SCHEDULE STATUS: NOT PUBLISHED YET/);
  assert.match(text, /Division: 10U/);
  assert.match(text, /Registered teams \(Example Region, 10U, Example City\), 2: Opponent Elite-Coach; Example Team-Coach/);
  assert.doesNotMatch(text, /Default Team 10B/);
});

test('personalizing never rewrites provider team names that contain the personalized team name', () => {
  const text = personalizeChatText(buildScheduleContext(pendingSnap), 'Example Team');
  assert.match(text, /Example Team-Coach/);
  assert.doesNotMatch(text, /Example Team Team/);
  assert.doesNotMatch(text, /⟦TEAM/);
  // The default team still reads naturally.
  assert.match(personalizeChatText(buildScheduleContext(pendingSnap)), /Our team is "Team"\./);
});

test('season schedule block labels current, completed, and upcoming tournaments', () => {
  const text = buildSeasonScheduleContext([
    { key:'fall-opener', name:'Example Opener', dates:'Sep 6–7', startDate:'2026-09-06', endDate:'2026-09-07', location:'Sample City', finish:'2nd' },
    { key:'swing', name:'Example Cup', dates:'Sep 19–20', startDate:'2026-09-19', endDate:'2026-09-20', location:'Example City' },
    { key:'autumn-cup', name:'Autumn Cup', dates:'Oct 10–11', startDate:'2026-10-10', endDate:'2026-10-11', location:'Example Region' },
  ], { currentKey:'swing', today:'2026-09-15' });
  assert.match(text, /Example Opener — Sep 6–7; Sample City; completed; finish 2nd Place/);
  assert.match(text, /Example Cup — Sep 19–20; Example City; CURRENT TOURNAMENT/);
  assert.match(text, /Autumn Cup — Oct 10–11; Example Region; upcoming/);
  assert.equal(buildSeasonScheduleContext([]), '');
});

test('bracket chat context keeps the provider placement label for an unresolved slot', () => {
  const text = buildBracketFrameContext({
    meta:{ providerTeamId:'ours' },
    brackets:[{ level:'championship', label:'Championship', teams:[], frame:[
      { gameNo:1, topId:'ours', topName:'[1] Example Team', botId:null, botName:'Bracket A 1st Place',
        topSeed:null, botSeed:null, topGame:null, botGame:null },
    ] }],
    bracketGames:{ championship:[] },
  });
  assert.match(text,/Bracket A 1st Place/);
  assert.doesNotMatch(text,/\[US\] vs TBD/);
});

test('the projected bracket block seeds by the tournament rules (head-to-head) when they are verified', () => {
  const standing = (teamID, record, PA) => ({ teamID, record, PA, PF:0 });
  const snap = projectionRules => ({ meta:{ providerTeamId:'W', projectionRules }, poolOrder:['A'],
    pools:{ A:{ teams:['W', 'X', 'Y', 'Z'].map(id => ({ id, name:id })), games:[{ key:'wx', hid:'W', aid:'X' }],
      standings:[standing('W', '1-1', 10), standing('X', '1-1', 1), standing('Y', '2-0', 0), standing('Z', '0-2', 0)] } },
    results:{ wx:{ status:'completed', topScore:1, botScore:0 } },
    brackets:[{ level:'gold', label:'Gold', size:4 }], bracketGames:{} });
  const seeding = text => text.match(/Projected seeding: (.*)/)[1];
  assert.equal(seeding(buildBracketProjection(snap(null))), '#1 Y, #2 X, #3 W, #4 Z');
  assert.equal(seeding(buildBracketProjection(snap({ verified:true, primary:'winPercentage', tiebreakers:['headToHead', 'runsAllowed'] }))),
    '#1 Y, #2 W, #3 X, #4 Z');
});


test('the projected bracket block puts our team first in an unresolved tie, like the dashboard', () => {
  const standing = (teamID, record) => ({ teamID, record, PA:5, PF:5 });
  // Our id sorts after the team we are tied with, so only the tie preference puts us first.
  const snap = projectionRules => ({ meta:{ providerTeamId:'Z', projectionRules }, poolOrder:['A'],
    pools:{ A:{ teams:['A', 'Y', 'Z'].map(id => ({ id, name:id })), games:[],
      standings:[standing('A', '1-1'), standing('Y', '2-0'), standing('Z', '1-1')] } },
    results:{}, brackets:[{ level:'gold', label:'Gold', size:3 }], bracketGames:{} });
  const seeding = text => text.match(/Projected seeding: (.*)/)[1];
  assert.equal(seeding(buildBracketProjection(snap(null))), '#1 Y, #2 Z, #3 A');
  assert.equal(seeding(buildBracketProjection(snap({ verified:true, primary:'winPercentage', tiebreakers:['runsAllowed'] }))),
    '#1 Y, #2 Z, #3 A');
});

test('the projected bracket block follows a posted order, and only falls back to wins without one', () => {
  // Storm played an extra game: 2-2 with fewer runs allowed than Rohnert Park, but NorCal ranks it lower.
  const standing = (teamID, record, PA, officialRank) => ({ teamID, record, PA, PF:0, officialRank });
  const snap = ranks => ({ meta:{ providerTeamId:'W' }, poolOrder:['A'],
    pools:{ A:{ teams:['W', 'RP', 'ST'].map(id => ({ id, name:id })), games:[],
      standings:[standing('W', '2-1', 9, ranks?.[0]), standing('RP', '2-1', 14, ranks?.[1]), standing('ST', '2-2', 13, ranks?.[2])] } },
    results:{}, brackets:[{ level:'gold', label:'Gold', size:3 }], bracketGames:{} });
  const seeding = text => text.match(/Projected seeding: (.*)/)[1];
  assert.equal(seeding(buildBracketProjection(snap(null))), '#1 W, #2 ST, #3 RP');
  assert.equal(seeding(buildBracketProjection(snap([1, 2, 3]))), '#1 W, #2 RP, #3 ST');
  // A manual score override in the pool makes the posted order stale.
  const overridden = snap([1, 2, 3]);
  overridden.pools.A.games = [{ key:'g', hid:'W', aid:'RP' }];
  overridden.results = { g:{ status:'completed', topScore:1, botScore:0, manual:true } };
  assert.equal(seeding(buildBracketProjection(overridden)), '#1 W, #2 ST, #3 RP');
});

test('chat seeds head-to-head ties within each division', () => {
  const standing = (teamID, record, PA) => ({teamID,record,PA,PF:0});
  const snap = {meta:{providerTeamId:'W',projectionRules:{verified:true,primary:'winPercentage',tiebreakers:['headToHead','runsAllowed']}},
    poolOrder:['B','C'], pools:{
      B:{teams:['W','X','Y','Z'].map(id=>({id,name:id,level:'B'})),games:[{key:'wx',hid:'W',aid:'X'}],
        standings:[standing('W','1-1',10),standing('X','1-1',1),standing('Y','2-0',0),standing('Z','0-2',0)]},
      C:{teams:[{id:'C',name:'C',level:'C'}],games:[],standings:[standing('C','1-1',0)]}
    },results:{wx:{status:'completed',topScore:1,botScore:0}},
    brackets:[{level:'gold',label:'Gold',division:'B',size:4},{level:'silver',label:'Silver',division:'C',size:1}],bracketGames:{}};
  assert.match(buildBracketProjection(snap), /Projected seeding: #1 Y, #2 W, #3 X, #4 Z/);
});
