import type { Eligibility, Opponent } from './scouting-types.ts';
type Raw=Record<string,any>;
// Converts a provider game time to an ISO timestamp, treating times without an offset as Pacific.
export function tournamentTimestamp(value:string|null|undefined):string|null{
  if(!value)return null;
  if(/[zZ]$|[+-]\d\d:\d\d$/.test(value))return Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value))return null;
  const base=Date.parse(value+'Z');if(!Number.isFinite(base))return null;
  let timestamp=base;
  // Provider times without an offset are Pacific, including when the function runtime is UTC.
  for(let i=0;i<2;i++){
    const offset=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'shortOffset'}).formatToParts(new Date(timestamp)).find(p=>p.type==='timeZoneName')?.value||'GMT';
    const match=/GMT([+-])(\d+)(?::(\d+))?/.exec(offset);
    const minutes=match?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]||0)):0;
    timestamp=base-minutes*60000;
  }
  return new Date(timestamp).toISOString();
}
// True when a game has a final result.
const done=(g:Raw)=>['completed','final','won','lost'].includes(g.status);
// Joins each bracket frame slot to its live game. Tourney Machine slots carry the live key; NorCal
// slots carry only a game number (extractBracketFrame has no _key), so fall back to gameNo like the
// dashboard does. Live values win, but a null live team never erases a slot's seeded team. Manual
// overrides apply under the resolved live key.
export function bracketGamesWithLive(frame:Raw[],live:Raw[],results:Record<string,Raw>):Raw[]{
  const byKey=new Map(live.filter(g=>g.key!=null).map(g=>[String(g.key),g]));
  const byNo=new Map(live.filter(g=>g.gameNo!=null).map(g=>[Math.abs(Number(g.gameNo)),g]));
  return frame.map(slot=>{
    const lv:Raw=(slot.key!=null&&byKey.get(String(slot.key)))||(slot.gameNo!=null&&byNo.get(Math.abs(Number(slot.gameNo))))||{};
    const key=lv.key??slot.key;
    const known=Object.fromEntries(Object.entries(lv).filter(([,v])=>v!=null));
    return {...slot,...known,...(key!=null?{key,...results[String(key)]}:{})};
  });
}
// True when a game is still to be played: not final or cancelled, and later today or in the future.
const active=(g:Raw,now:number)=>{
  if(done(g)||['cancelled','canceled'].includes(g.status))return false;
  const t=Date.parse(tournamentTimestamp(g.time||g.dateTime||g.t)||'');
  return !Number.isFinite(t)||t>now||new Date(t).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'})===new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
};
// Lists the teams we may still face: confirmed pool and bracket opponents, plus possible opponents
// along our remaining bracket path once brackets are filled.
export function scoutingOpponents(snap:Raw,now=Date.now()):Eligibility{
  const myId=String(snap?.meta?.providerTeamId||'');
  const opponents=new Map<string,Opponent>();
  // Records an opponent once, keeping its earliest game time and upgrading it to confirmed when any
  // matchup is.
  const add=(id:string,name:string,role:string,key:string,time:string|null)=>{
    if(!id||id===myId)return;
    const prior=opponents.get(id);
    const date=tournamentTimestamp(time);
    if(prior){if(!prior.gameKeys.includes(key))prior.gameKeys.push(key);if(date&&(!prior.firstPitch||Date.parse(date)<Date.parse(prior.firstPitch)))prior.firstPitch=date;if(role==='Confirmed opponent')prior.role=role;}
    else opponents.set(id,{id,name:name||id,role,gameKeys:[key],firstPitch:date});
  };
  if(!myId)return {bracketsSet:false,opponents:[]};
  const lastDay=[...(snap.meta?.dates||[])].sort().at(-1);
  if(lastDay&&lastDay<new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'}))return {bracketsSet:false,opponents:[]};
  for(const pool of Object.values(snap.pools||{}) as Raw[]){
    for(const g of pool.games||pool.schedule||[]){
      const key=String(g.key||g._key||''),result=snap.results?.[key]||{};
      const hid=String(g.hid||g.topTeamID||''),aid=String(g.aid||g.botTeamID||'');
      if(!active({...g,...result},now))continue;
      if(hid===myId)add(aid,g.an||g.botTeam,'Confirmed opponent',key,g.time||g.t||g.dateTime||null);
      if(aid===myId)add(hid,g.hn||g.topTeam,'Confirmed opponent',key,g.time||g.t||g.dateTime||null);
    }
  }
  let bracketsSet=false;
  for(const bracket of snap.brackets||[]){
    const games:Raw[]=bracketGamesWithLive(bracket.frame||[],snap.bracketGames?.[bracket.level]||[],snap.results||{});
    const byNo=new Map(games.map(g=>[Math.abs(Number(g.gameNo)),g]));
    const names=new Map<string,string>();
    for(const g of games){if(g.topId)names.set(String(g.topId),g.topName);if(g.botId)names.set(String(g.botId),g.botName);}
    let unresolved=games.some(g=>!g.topId&&!g.botId&&!g.topGame&&!g.botGame);
    // Resolves which teams can occupy one side of a bracket game by following feeder games, and
    // flags placeholders that are not filled yet.
    function side(g:Raw,s:string,seen=new Set<number>()):Set<string>{
      const id=g[s+'Id'];if(id)return new Set([String(id)]);
      const feed=Number(g[s+'Game']||0);
      if(!feed){if(g[s+'Seed']||/place|seed|TBD/i.test(g[s+'Name']||''))unresolved=true;return new Set();}
      const no=Math.abs(feed),prev=byNo.get(no);
      if(!prev||seen.has(no)){unresolved=true;return new Set();}
      const visited=new Set(seen);visited.add(no);
      const top=side(prev,'top',visited),bot=side(prev,'bot',visited);
      if(done(prev)){
        let topWins:boolean|null=null;
        if(prev.topScore!=null&&prev.botScore!=null&&Number(prev.topScore)!==Number(prev.botScore))topWins=Number(prev.topScore)>Number(prev.botScore);
        else if(['won','lost'].includes(prev.status)){const mineBottom=prev.manual&&prev.botId===myId;topWins=prev.status==='won'?!mineBottom:!!mineBottom;}
        if(topWins!==null)return feed>0?(topWins?top:bot):(topWins?bot:top);
      }
      // An undecided bye has no loser.
      if(feed<0&&(!top.size||!bot.size))return new Set();
      return new Set([...top,...bot]);
    }
    const possibilities=games.map(g=>({g,top:side(g,'top'),bot:side(g,'bot')}));
    if(!possibilities.some(p=>p.top.has(myId)||p.bot.has(myId)))continue;
    if(unresolved||!games.length)continue;
    bracketsSet=true;
    for(const {g,top,bot} of possibilities){
      if(!active(g,now))continue;
      const other=top.has(myId)?bot:bot.has(myId)?top:null;
      if(!other)continue;
      for(const id of other)add(id,names.get(id)||id,(g.topId===myId&&g.botId)||(g.botId===myId&&g.topId)?'Confirmed opponent':'Possible bracket opponent',String(g.key),g.time||null);
    }
  }
  return {bracketsSet,opponents:[...opponents.values()].sort((a,b)=>(a.firstPitch||'z').localeCompare(b.firstPitch||'z')||a.name.localeCompare(b.name))};
}
