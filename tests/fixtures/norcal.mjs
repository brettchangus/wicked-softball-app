export const game = (key, no, topId, top, botId, bot, time='2026-08-01T09:00:00') => ({
  _key:key, gameNo:no, gameTime:time, facilityShortName:'EXC', facilityName:'Example Sports Complex', fieldShortName:'Field A',
  topTeamID:topId, topTeam:top, botTeamID:botId, botTeam:bot,
});
export const pool = (no, games, standings=[]) => ({ pools:[{ poolNo:no, pool:`Pool ${String.fromCharCode(64+no)}`, schedule:games, standings }] });
export const roundGame = ({ no, round=2, topSeed=null, botSeed=null, topGame=null, botGame=null, topId=null, topName=null, botId=null, botName=null, time='2026-08-02T09:00:00' }) => ({
  gameNo:no, topSeed, botSeed, topGame, botGame, datetime:time, field:'Field B', facility:{name:'Example Sports Complex',city:'Example Venue City'},
  topTeam:topId?{teamID:topId,label:topName}:{teamID:null,label:topName}, botTeam:botId?{teamID:botId,label:botName}:{teamID:null,label:botName},
});
export const bracket = (teamCnt, games) => ({ teamCnt, bracket:{ roundSets:[{ index:2, rounds:[{ games }] }] } });

export function router(responses) {
  return async url => {
    const hit = Object.entries(responses).find(([fragment]) => url.includes(fragment));
    if (!hit) throw new Error(`unexpected fixture URL ${url}`);
    const value = hit[1];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
}
const stats = levels => async id => ({ season:'10-2', level:levels[id] || 'B', rank:id==='ours'?2:null, rankOf:50, games:[], tournaments:[] });
export const common = divisions => ({
  divisions,
  facilities:[{ name:'Example Sports Complex', address:'123 Main', location:'Example Venue City, CA', zip:'00000', abr:'EXC', divisions:divisions.map(d=>({_key:d._key})) }],
  dates:[{ dates:[{date:'2026-08-01T00:00:00'},{date:'2026-08-02T00:00:00'}] }],
});

export function combinedFixture({ emptyStandings=false, failSilver=false }={}) {
  const div={ _key:'div10', name:'10U', rounds:[
    { _key:'pool-r', type:'pool', name:'Pool Play', pools:[{},{}] },
    { _key:'gold-r', type:'bracket', name:'Gold Bracket', bracketTemplateShortName:'SE-2' },
    { _key:'silver-r', type:'bracket', name:'Silver Bracket', bracketTemplateShortName:'SE-2' },
  ]};
  const g1=[game('p1',1,'ours','Ours','b2','B Team'),game('p2',2,'b2','B Team','ours','Ours')];
  const g2=[game('p3',3,'c1','C One','c2','C Two'),game('p4',4,'c2','C Two','c1','C One')];
  const st = emptyStandings ? [] : [{teamID:'ours',team:'Ours',record:'1-0',PF:5,PA:1}];
  return {
    fetchJson:router({
      'info-v3.0':common([div]), 'poolDisplay/false/pool-r/1/0':pool(1,g1,st), 'poolDisplay/false/pool-r/2/0':pool(2,g2,[]),
      'Round/bracket/gold-r':bracket(2,[roundGame({no:1,topSeed:1,botSeed:2})]),
      'Round/bracket/silver-r':failSilver?new Error('fixture bracket failure'):bracket(2,[roundGame({no:1,topSeed:1,botSeed:2})]),
      'header4EP':{name:'Combined Classic'},
    }),
    fetchTeamStatsFn:stats({ours:'B',b2:'B',c1:'C',c2:'C'}),
  };
}

export function splitFixture() {
  const b={ _key:'divB', name:'10B', rounds:[{_key:'pool-b',type:'pool',name:'10B Pool',pools:[{}]},{_key:'br-b',type:'bracket',name:'Gold Bracket',bracketTemplateShortName:'SE-2'}] };
  const c={ _key:'divC', name:'10C', rounds:[{_key:'pool-c',type:'pool',name:'10C Pool',pools:[{}]},{_key:'br-c',type:'bracket',name:'Silver Bracket',bracketTemplateShortName:'SE-2'}] };
  return { fetchJson:router({
    'info-v3.0':common([b,c]), 'poolDisplay/false/pool-b/1/0':pool(1,[game('bp1',1,'ours','Ours','b2','B Two')]),
    'poolDisplay/false/pool-c/1/0':pool(1,[game('cp1',1,'c1','C One','c2','C Two')]),
    'Round/bracket/br-b':bracket(2,[roundGame({no:1,topSeed:1,botSeed:2})]), 'Round/bracket/br-c':bracket(2,[roundGame({no:1,topSeed:1,botSeed:2})]),
    'header4EP':{name:'Split Classic'},
  }), fetchTeamStatsFn:stats({ours:'B',b2:'B',c1:'C',c2:'C'}) };
}

export function bracketOnlyFixture() {
  const div={ _key:'div10', name:'10U', rounds:[{_key:'only-br',type:'bracket',name:'Championship Bracket',bracketTemplateShortName:'SE-4'}] };
  const duplicateSeedSlot=roundGame({no:1,topSeed:1,botSeed:4});
  const assignedSlot=roundGame({no:1,topId:'ours',topName:'Ours',botId:'t4',botName:'Team Four'});
  return { fetchJson:router({
    'info-v3.0':common([div]),
    'Round/bracket/only-br':bracket(4,[duplicateSeedSlot,assignedSlot,roundGame({no:2,topSeed:2,botSeed:3,topId:'t2',topName:'Team Two',botId:'t3',botName:'Team Three'}),roundGame({no:3,round:1,topGame:1,botGame:2,time:'2026-08-02T11:00:00'})]),
    'header4EP':{name:'Bracket Only'},
  }), fetchTeamStatsFn:stats({ours:'B',t2:'B',t3:'B',t4:'B'}) };
}

export const noDivisionFixture = {
  fetchJson:router({'info-v3.0':common([{_key:'div12',name:'12U',rounds:[]}])}),
  fetchTeamStatsFn:stats({}),
};

export const noGeocode = async () => ({lat:0.1,lon:0.2});
