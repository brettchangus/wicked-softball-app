import type { Collection, Counts, PlayerLine, ScoutGame } from './scouting-types.ts';

const API='https://api.team-manager.gc.com';
type Raw=Record<string,any>;
// A GameChanger failure with a code the admin page acts on (for example an expired token).
export class GameChangerError extends Error {
  code:string;
  constructor(message:string,code='gameChangerCollection'){super(message);this.code=code;}
}
// Reads a field by its camelCase name or GameChanger's snake_case equivalent.
const value=(r:Raw,key:string)=>r?.[key]??r?.[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())];
// Parses a non-negative numeric stat, or null when it is missing or invalid.
const count=(v:unknown):number|null=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
// Converts innings pitched (scorebook 2.2 or GameChanger's decimal thirds) to a whole number of
// outs, or null when invalid.
export function inningsToOuts(v:unknown):number|null {
  const text=String(v??'');
  // Accept scorebook notation (2.2) and GC's decimal thirds (2.6666666666666665).
  const match=/^(\d+)(?:\.([012]))?$/.exec(text);
  if(match){const outs=Number(match[1])*3+Number(match[2]||0);return Number.isSafeInteger(outs)?outs:null;}
  if(!/^\d+\.\d+$/.test(text))return null;
  const exactOuts=Number(text)*3,outs=Math.round(exactOuts);
  return Number.isSafeInteger(outs)&&Math.abs(exactOuts-outs)<1e-8?outs:null;
}
// Turns a GameChanger schedule into completed, scored games before the cutoff, newest first,
// marking scrimmages as excluded.
export function parseSchedule(rows:unknown,publicId:string,cutoff:string):ScoutGame[] {
  if(!Array.isArray(rows))throw new GameChangerError('GameChanger returned an unrecognized schedule.');
  const seen=new Set<string>();
  return rows.flatMap((row:Raw)=>{
    const id=String(row.id||''),date=String(row.start_ts||row.startTs||'');
    const score=row.score||{},opponent=row.opponent_team||row.opponentTeam||{};
    const rf=count(score.team),ra=count(score.opponent_team??score.opponentTeam);
    const end=Date.parse(row.end_ts||row.endTs||'');
    if(!/^[\w-]+$/.test(id)||seen.has(id)||!Number.isFinite(Date.parse(date))||Date.parse(date)>=Date.parse(cutoff)||(Number.isFinite(end)&&end>=Date.parse(cutoff))||!['completed','final'].includes(row.game_status||row.gameStatus)||rf===null||ra===null||!Number.isSafeInteger(rf)||!Number.isSafeInteger(ra))return [];
    seen.add(id);
    return [{id,date,opponent:String(opponent.name||'Unknown opponent'),opponentId:opponent.id||null,opponentPublicId:opponent.public_id||opponent.publicId||null,rf,ra,source:'https://web.gc.com/teams/'+publicId+'/schedule/'+id+'/box-score',kind:row.is_scrimmage||/scrimmage|practice|forfeit/i.test(row.event_type||row.game_type||row.title||'')?'excluded':'competitive',innings:[],hitters:[],pitchers:[],warnings:[],boxScore:false}];
  }).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
}
// Builds one stat line per player from a box-score group, merging the extra stats (2B, HR, SB, ...)
// that GameChanger lists separately.
function normalizeLines(team:Raw,key:string,extraKey:string):PlayerLine[] {
  const rows=value(team,key),players=team.players||{},extras=value(team,extraKey)||[];
  if(!Array.isArray(rows))return [];
  return rows.flatMap((row:Raw)=>{
    const id=String(value(row,'playerID')||row.player_id||'');
    const player=players[id];
    if(!id||!player)return [];
    const name=[value(player,'firstName'),value(player,'lastName')].filter(Boolean).join(' ')||String(player.name||'');
    if(!name)return [];
    const stats:Counts={};
    for(const [key,v] of Object.entries(row.stats||{}))stats[key]=count(v);
    // GC's complete extra-count group is sparse: missing player rows represent zero.
    // An absent group remains unavailable. BF/pitch counts are never inferred this way.
    if(key==='lineupStats'&&team.lineupExtraComplete)for(const extra of ['2B','3B','HR','HBP','SF','SH','SB','CS'])stats[extra]=0;
    for(const extra of extras){
      const key=value(extra,'statName');
      for(const pair of extra.stat||[])if(String(pair[0])===id)stats[key==='SHF'?'SF':key==='SHB'?'SH':key]=count(pair[1]);
    }
    if(key==='pitcherStats')stats.OUTS=inningsToOuts(stats.IP);
    return [{id,name,number:String(player.number??player.jersey_number??player.jerseyNumber??''),stats,positions:row.positions||[]}];
  });
}
// Adds player batting and pitching lines from a box score to a game, after checking the team
// identity and noting any scorebook inconsistencies.
export function parseBoxScore(raw:Raw,game:ScoutGame,publicId?:string):ScoutGame {
  if(raw.preview||raw.is_preview)throw new GameChangerError('Real player box score is unavailable.');
  if(publicId&&!raw[publicId])throw new GameChangerError('GameChanger box-score team identity does not match the saved link.');
  if(publicId&&raw[publicId]){
    // Reshapes one team's authenticated box-score groups into the lineup and pitching fields parsed
    // below.
    const convert=(team:Raw)=>{
      const players=Object.fromEntries((team.players||[]).map((p:Raw)=>[p.id,p]));
      const lineup=(team.groups||[]).find((g:Raw)=>g.category==='lineup');
      const pitching=(team.groups||[]).find((g:Raw)=>g.category==='pitching');
      // Converts a group's extra-stat lists into statName/[playerId, value] pairs.
      const extras=(group:Raw)=>group?.extra?.map((e:Raw)=>({statName:e.stat_name,stat:(e.stats||[]).map((p:Raw)=>[p.player_id,p.value])}))||[];
      return {players,lineupStats:lineup?.stats,lineupTeamStats:lineup?.team_stats,lineupExtraComplete:Array.isArray(lineup?.extra),lineupExtraStats:extras(lineup),pitcherStats:pitching?.stats,pitcherTeamStats:pitching?.team_stats,pitcherExtraStats:extras(pitching)};
    };
    const otherId=Object.keys(raw).find(id=>id!==publicId);
    if(!otherId)throw new GameChangerError('Opponent box score is missing.');
    raw={ownTeam:convert(raw[publicId]),opponentTeam:convert(raw[otherId])};
  }
  // Accept only the authenticated endpoint's real own/opponent team shape, never page previews.
  const own=value(raw,'ownTeam'),other=value(raw,'opponentTeam');
  if(!own||!other||raw.preview||raw.is_preview)throw new GameChangerError('Real player box score is unavailable.');
  const batting=value(own,'lineupTeamStats'),oppBatting=value(other,'lineupTeamStats');
  const hitters=normalizeLines(own,'lineupStats','lineupExtraStats'),pitchers=normalizeLines(own,'pitcherStats','pitcherExtraStats');
  if(!batting||!oppBatting||!hitters.length)throw new GameChangerError('GameChanger box score is incomplete.');
  const warnings:string[]=[],notes:string[]=[];
  if(new Set(hitters.map(p=>p.id)).size!==hitters.length||new Set(pitchers.map(p=>p.id)).size!==pitchers.length)warnings.push('Duplicate player lines; affected player totals withheld.');
  if(count(batting.R)!==game.rf||count(oppBatting.R)!==game.ra)notes.push('Box-score runs differ from the final score; player stats are used as reported.');
  if(hitters.some(p=>p.stats.H!==null&&p.stats.AB!==null&&p.stats.H!>p.stats.AB!))notes.push('Player hits exceed at-bats; player stats are used as reported.');
  if(count(batting.H)!==null&&hitters.every(p=>p.stats.H!==null)&&hitters.reduce((n,p)=>n+(p.stats.H||0),0)!==count(batting.H))notes.push('Player hits differ from team hits; player stats are used as reported.');
  if(pitchers.some(p=>p.stats.BF!=null&&['SO','BB','H'].some(key=>p.stats[key]!=null&&p.stats[key]!>p.stats.BF!)))notes.push('Pitching counts exceed batters faced; player stats are used as reported.');
  for(const p of hitters){
    const h=p.stats.H,tb=p.stats.TB,xbh=['2B','3B','HR'].every(key=>p.stats[key]!=null)?p.stats['2B']!+p.stats['3B']!+p.stats.HR!:null;
    if(h!=null&&((tb!=null&&(tb<h||tb>4*h))||(xbh!=null&&xbh>h))){
      notes.push('Extra-base counts are inconsistent; player stats are used as reported.');
    }
  }
  if(hitters.length&&hitters.every(p=>p.stats.R!=null)&&hitters.reduce((n,p)=>n+p.stats.R!,0)!==game.rf){
    notes.push('Individual player runs differ from the final score; player runs and RBI are used as reported.');
  }
  return {...game,hitters:warnings.length?[]:hitters,pitchers:warnings.length?[]:pitchers,boxScore:!warnings.length,warnings:[...warnings,...notes]};
}
// Authenticated GET to the GameChanger API, mapping 401/403 and other failures to clear errors.
async function gc(path:string,token:string,fetchImpl:typeof fetch=fetch):Promise<any>{
  const response=await fetchImpl(API+path,{headers:{'gc-token':token,'gc-app-name':'web',Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(response.status===401)throw new GameChangerError('GameChanger token expired or invalid. Paste a fresh token.','gameChangerToken');
  if(response.status===403)throw new GameChangerError('GameChanger does not permit access to this box score.','gameChangerPermission');
  if(!response.ok)throw new GameChangerError('GameChanger collection failed ('+response.status+').');
  return response.json();
}
// Collects a team's season schedule and, for eligible games, line scores and box scores, using
// three parallel workers.
export async function collectGameChanger(url:string,token:string,{cutoff=new Date().toISOString(),fetchImpl=fetch,boxLimit=Infinity,boxSince}:{cutoff?:string;fetchImpl?:typeof fetch;boxLimit?:number;boxSince?:string}={}):Promise<Collection>{
  const publicId=/^https:\/\/web\.gc\.com\/teams\/([\w-]+)/i.exec(url)?.[1];
  if(!publicId)throw new GameChangerError('Set a valid GameChanger link for this opponent first.');
  if(!token.trim())throw new GameChangerError('Enter a GameChanger token.','gameChangerToken');
  const [profile,schedule]=await Promise.all([gc('/public/teams/'+publicId,token,fetchImpl),gc('/public/teams/'+publicId+'/games',token,fetchImpl)]);
  if(profile.id!==publicId)throw new GameChangerError('GameChanger team identity does not match the saved link.');
  const games=parseSchedule(schedule,publicId,cutoff),warnings:string[]=[];
  // Retain all season scores for class evidence; import every eligible box score in the report period.
  const eligible=games.map((g,i)=>({g,i})).filter(({g})=>g.kind==='competitive'&&(!boxSince||Date.parse(g.date)>=Date.parse(boxSince)));
  const targets=eligible.slice(0,boxLimit);let next=0,tokenRejected=false;
  // Takes the next game from the shared queue until none remain or the token is rejected.
  const worker=async()=>{while(!tokenRejected&&next<targets.length){const i=targets[next++].i;
    try{
      const details=await gc('/public/game-stream-processing/'+games[i].id+'/details?include=line_scores',token,fetchImpl);
      if(details.id!==games[i].id)throw new GameChangerError('GameChanger game identity does not match the schedule.');
      const innings=details.line_score?.team?.scores;
      if(Array.isArray(innings)&&innings.every((n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0))games[i].innings=innings;
      games[i]=parseBoxScore(await gc('/game-stream-processing/'+games[i].id+'/boxscore',token,fetchImpl),games[i],publicId);
    }
    catch(error){if(error instanceof GameChangerError&&error.code==='gameChangerToken'){tokenRejected=true;throw error;}games[i].warnings.push(error instanceof GameChangerError?error.message:'Could not collect this box score.');}
  }};
  // Three workers bound provider load while keeping full-period collection within a manual request.
  await Promise.all(Array.from({length:Math.min(3,targets.length)},worker));
  if(boxLimit>0&&eligible.length>boxLimit)warnings.push('Player box scores are available for only '+targets.length+' of '+eligible.length+' games in the requested period.');
  const seasonName=typeof profile.team_season?.season==='string'?profile.team_season.season:profile.team_season?.season?.name||null;
  const year=Number(profile.team_season?.year||profile.team_season?.season?.year)||null;
  return {publicId,name:String(profile.name||''),season:[seasonName,year].filter(Boolean).join(' '),year,seasonName,games,warnings,collectedAt:new Date().toISOString()};
}
