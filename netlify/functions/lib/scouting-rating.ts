import type { ScoutGame } from './scouting-types.ts';
import { readStructure, readResults, readOverrides } from './snapshot.js';
import { loadDirectoryMatches } from './team-directory.js';
import { fetchTeamStats } from './norcal.js';
import { teamPlacement } from './tm-placement.js';
import { teamNameKey } from './divisions.js';
import { tournamentTimestamp } from './scouting-opponents.ts';
// The 1–4 star rating in a scouting report's title. Rule-based and explainable:
//   4    the best: won a top-bracket tournament with only a couple of losses
//   3    very good: expected to reach the gold semifinals or better
//   2    good: typically in the gold bracket, but not always
//   1    C level: typically silver or below
// Season results set the base (average margin, adjusted for the opponent's class and shrunk toward
// 2 stars on small samples); tournament finishes set a floor; a C class caps it. Half stars allowed.
type Raw=Record<string,any>;
type Game=Pick<ScoutGame,'rf'|'ra'|'level'>;
// One finish in a tournament this season. `top` is true for the top bracket (gold, premier, or a
// tournament's only bracket).
export type Finish={event:string;place:number;bracket:string|null;top:boolean};
export type StarRating={stars:number;reasons:string[]};

export const RATING={
  marginCap:10,          // run-rule blowouts count as 10
  cDiscount:3,           // beating a C team by 3 counts like tying a B team
  shrinkGames:3,         // pseudo-games at an even margin, so two games can't swing the rating
  runsPerStar:4,         // +4 adjusted runs per game = one star above the 2-star midpoint
  resultsCap:3.5,        // results alone never reach 4 stars without a tournament win
  cCap:2,
};
const ordinal=(n:number)=>n+(n%100>=11&&n%100<=13?'th':['th','st','nd','rd'][n%10]||'th');
const half=(n:number)=>Math.round(n*2)/2;
const clamp=(n:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,n));
// "Only a couple of losses": two, or up to 15% of a long season.
export const fewLosses=(losses:number,games:number)=>losses<=Math.max(2,Math.floor(games*.15));
// The floor a finish sets, or 0 when it says nothing about the top tier.
function finishFloor(f:Finish,losses:number,games:number):number{
  if(!f.top)return 0;
  // With no games there is no evidence of "only a couple of losses".
  if(f.place===1)return games&&fewLosses(losses,games)?4:3.5;
  if(f.place===2)return 3;
  if(f.place<=4)return 2.5;
  return 0;
}
const finishLabel=(f:Finish)=>ordinal(f.place)+' in '+f.event+(f.bracket?' ('+f.bracket+')':'');

// The star rating from a report's games (all classes), the team's own class, and its finishes this
// season; null with no evidence at all.
export function starRating(games:Game[],level:string|null,finishes:Finish[]=[]):StarRating|null{
  // `games` are a report view's games, which already leave out unplayed ones (wasPlayed).
  const n=games.length,losses=games.filter(g=>g.ra>g.rf).length;
  const reasons:string[]=[];
  let stars:number|null=null;
  if(n){
    const adjusted=games.map(g=>clamp(g.rf-g.ra,-RATING.marginCap,RATING.marginCap)-(g.level?.group==='C'?RATING.cDiscount:0));
    const average=adjusted.reduce((a,b)=>a+b,0)/n;
    stars=clamp(2+average*n/(n+RATING.shrinkGames)/RATING.runsPerStar,1,RATING.resultsCap);
    const wins=games.filter(g=>g.rf>g.ra).length,ties=n-wins-losses;
    reasons.push(wins+'-'+losses+(ties?'-'+ties:'')+' since Sep 1, '+(average>=0?'+':'')+average.toFixed(1)+' runs per game adjusted for opponent class'+(n<5?' (few games)':''));
  }
  const best=[...finishes].sort((a,b)=>finishFloor(b,losses,n)-finishFloor(a,losses,n)||a.place-b.place)[0];
  const floor=best?finishFloor(best,losses,n):0;
  if(best&&floor)reasons.push(finishLabel(best));
  if(floor>(stars??0))stars=floor;
  if(stars===null){
    if(level!=='B'&&level!=='C')return null;
    stars=level==='C'?1:2;reasons.push('No games since Sep 1; based on class '+level);
  }
  if(level==='C'&&stars>RATING.cCap){stars=RATING.cCap;reasons.push('Capped at '+RATING.cCap+' stars for a C team');}
  return {stars:half(stars),reasons};
}

// Normalized "team" and "coach" parts of a roster name: "Castro Valley Synergy 10U - Galeana",
// "West Valley Slammers - 10U (Pirotta)". Only age tokens ("10U", "U10") are dropped; a class
// ("10B" / "10C") or any other number stays, so sister teams never collapse into one.
function nameParts(value:string){
  const clean=String(value||'').replace(/^\s*\[\d+\]\s*/,'');
  const paren=/\(([^)]+)\)\s*$/.exec(clean);
  const bare=clean.replace(/\s*\([^)]*\)\s*$/,'');
  const dash=/^(.*\S)\s*[-–—]\s*([^-–—]+)$/.exec(bare);
  const key=(s:string)=>teamNameKey(s.replace(/\b(?:\d{1,2}\s*u|u\s*\d{1,2})\b/gi,' ')) as string;
  return {team:key(dash?dash[1]:bare),coach:key(paren?paren[1]:dash?dash[2]:'')};
}
// True when two roster names are the same team across tournaments. Both the team and coach parts
// must match, so two coaches' teams from one club ("LGCS Magic - O'Reilly" / "- Yamate") never do.
export function sameTeamName(a:string,b:string):boolean{
  const x=nameParts(a),y=nameParts(b);
  if(!x.team||x.team!==y.team)return false;
  return x.coach===y.coach;
}

// The end of a NorCal tournament from its `dates` text ("May 21 - 25, 2026", "Oct 31 - Nov 2,
// 2026"), as the last day's end in Pacific time; null when the text can't be read.
export function norcalTournamentEnd(dates:unknown):string|null{
  const m=/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}))?,\s*(\d{4})/.exec(String(dates||''));
  if(!m)return null;
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf((m[3]||m[1]).toLowerCase());
  if(month<0)return null;
  return tournamentTimestamp(m[5]+'-'+String(month+1).padStart(2,'0')+'-'+String(m[4]||m[2]).padStart(2,'0')+'T23:59:59');
}
// Finishes from a NorCal Team/{id} payload's tournaments, skipping `skip` event ids (tournaments
// read from this season's own brackets instead) and, with a `cutoff`, any tournament that hadn't
// ended by then (or whose dates can't be read): a saved pregame report never gains later results. NorCal's place doesn't say which bracket it was
// in, so only a single-class B-or-better event ("10-B", "10U-B", "10B") is top tier; a combined
// "10-B/C" or "10-Open" place may be a silver bracket and sets no floor.
export function norcalFinishes(tournaments:Raw[]=[],skip:Set<string>=new Set(),cutoff?:string):Finish[]{
  const before=(t:Raw)=>{if(!cutoff)return true;const end=norcalTournamentEnd(t.dates);return !!end&&Date.parse(end)<Date.parse(cutoff);};
  return tournaments.filter(t=>Number(t.place)>0&&!skip.has(String(t.id))&&before(t)).map(t=>({event:String(t.short||t.name||'NorCal tournament').trim(),place:Number(t.place),bracket:null,
    top:/^(?:A|B|Gold|Premier)$/i.test(String(t.class||'').trim().replace(/^\d+\s*U?\s*[-–\s]?\s*/i,''))}));
}
// A placement ({label:"Gold Bracket", place:"1st Place"}) as a finish. A Tourney Machine bracket
// is top unless silver or lower; for NorCal, `topLabel` names the structure's top bracket.
export function placementFinish(placement:{label:string;place:string}|null,event:string,topLabel?:string|null):Finish|null{
  const place=Number(/^(\d+)/.exec(placement?.place||'')?.[1]);
  if(!placement||!place)return null;
  const bracket=placement.label.replace(/\s*Bracket$/i,'').trim();
  // NorCal labels carry the age: "10U - Gold".
  const name=bracket.replace(/^.*[-–—]\s*/,'');
  return {event,place,bracket:/^(gold|silver|bronze|premier|platinum|copper)\b/i.test(name)?name.split(/\s/)[0]:null,
    top:topLabel!==undefined?bracket===topLabel:!/^(silver|bronze|copper)\b/i.test(bracket)};
}
// A NorCal structure's top bracket label: its first bracket that isn't a C division's.
const topNorcalBracket=(structure:Raw):string|null=>((structure.brackets||[]) as Raw[]).find(b=>b.division!=='C')?.label??null;
// Every team in a tournament structure: pool teams plus teams placed straight into a bracket (a
// bracket-only NorCal event has no pools), once each.
export function structureTeams(structure:Raw|null):Raw[]{
  const all:Raw[]=[...Object.values(structure?.pools||{}).flatMap((p:any)=>p.teams||[]),...((structure?.brackets||[]) as Raw[]).flatMap(b=>b.teams||[])];
  const seen=new Set<string>();
  return all.filter(t=>t?.id!=null&&!seen.has(String(t.id))&&(seen.add(String(t.id)),true));
}

const publicIdOf=(url:string|undefined)=>/\/teams\/([\w-]+)/.exec(url||'')?.[1]||null;
// Resolves to null after `ms`, so a slow provider can't hold a report open.
const within=<T>(promise:Promise<T>,ms:number):Promise<T|null>=>Promise.race([promise,new Promise<null>(resolve=>{setTimeout(()=>resolve(null),ms).unref?.();})]);
const FINISH_TTL=10*60*1000,NORCAL_WAIT=4000,GAME_LENGTH=2*60*60*1000;
// The opponent's NorCal team: its id, and its class for display ("10B", "10 Rec") when NorCal names one.
export type NorcalTeam={id:string;level:string|null};
type Collected={finishes:Finish[];norcal:NorcalTeam|null;complete:boolean};
const finishCache=new Map<string,{at:number;value:Promise<Collected>}>();
// The opponent's finishes this season that were decided before `cutoff` (a report's as-of time,
// so a saved pregame report never gains a later result, including the tournament it previews),
// plus the NorCal team those finishes were looked up under. Cached per opponent and cutoff for ten
// minutes since every report open asks. Only a complete collection is kept: one where a tournament
// failed to load or NorCal didn't answer is used once and asked again next time. Never throws.
export async function seasonScouting(context:Raw,opponent:{id:string;name:string;sourceUrl:string},current:Raw|null,cutoff:string):Promise<{finishes:Finish[];norcal:NorcalTeam|null}>{
  const key=JSON.stringify([context.scope,opponent.id,opponent.name,opponent.sourceUrl,cutoff]);
  const now=Date.now(),hit=finishCache.get(key);
  if(hit&&now-hit.at<FINISH_TTL){const {finishes,norcal}=await hit.value;return {finishes,norcal};}
  for(const [k,entry] of finishCache)if(now-entry.at>=FINISH_TTL)finishCache.delete(k);
  const value=collectSeasonFinishes(context,opponent,current,cutoff).catch(()=>({finishes:[],norcal:null,complete:false}));
  const entry={at:now,value};
  finishCache.set(key,entry);
  const collected=await value;
  if(!collected.complete&&finishCache.get(key)===entry)finishCache.delete(key);
  return {finishes:collected.finishes,norcal:collected.norcal};
}
// Just the finishes from seasonScouting.
export async function seasonFinishes(context:Raw,opponent:{id:string;name:string;sourceUrl:string},current:Raw|null,cutoff:string):Promise<Finish[]>{
  return (await seasonScouting(context,opponent,current,cutoff)).finishes;
}
// Every tournament in the season's schedule where the same team (by id, GameChanger link, or exact
// team+coach name) has a completed bracket run, AST, Tourney Machine and NorCal alike, plus
// NorCal's own tournament list for its events outside the schedule. A manual bracket score
// correction counts, as it does on the dashboard.
async function collectSeasonFinishes(context:Raw,opponent:{id:string;name:string;sourceUrl:string},current:Raw|null,cutoff:string):Promise<Collected>{
  const publicId=publicIdOf(opponent.sourceUrl);
  // NorCal ids the provider itself vouches for (this NorCal tournament's id, a saved NorCal class
  // identity) win over ones found by link or name in other tournaments.
  const known=new Set<string>(),matched=new Set<string>(),linked=new Set<string>(),scheduled=new Set<string>();
  if(current?.meta?.provider==='norcal')known.add(String(opponent.id));
  const identity=publicId?context.season?.teamConfig?.scoutingIdentities?.[publicId]:null;
  const identityId=/\/pages\/team\/detail\/(\d+)/.exec(identity?.source||'')?.[1];
  if(identityId)known.add(identityId);
  const finishes:Finish[]=[];
  let complete=true;
  const events=Object.entries(context.season?.events||{}) as [string,Raw][];
  await Promise.all(events.map(async([eventKey,event])=>{
    try{
      const scope={...context.scope,eventKey} as any;
      const structure=eventKey===context.eventKey&&current?current:await readStructure(event.providerRef,scope);
      if(!structure)return;
      const norcal=structure.meta?.provider==='norcal';
      if(!norcal&&structure.meta?.provider!=='tourneymachine')return;
      const teams=structureTeams(structure);
      const links=(await loadDirectoryMatches({...context,event,eventKey},structure)).links as Record<string,string>;
      // In another NorCal tournament a trusted NorCal id decides; a link or name match with a
      // different id is another team and never lends its finish. Two conflicting trusted ids
      // match nothing, as in the NorCal lookup below.
      const byLink=eventKey!==context.eventKey&&!(norcal&&known.size)?teams.find(t=>publicId&&publicIdOf(links[t.id])===publicId):undefined;
      const team=eventKey===context.eventKey?teams.find(t=>String(t.id)===String(opponent.id))
        :norcal&&known.size?(known.size===1?teams.find(t=>known.has(String(t.id))):null)
        :byLink||(()=>{const hits=teams.filter(t=>sameTeamName(t.name,opponent.name));return hits.length===1?hits[0]:null;})();
      if(!team)return;
      if(norcal&&eventKey!==context.eventKey){matched.add(String(team.id));if(team===byLink)linked.add(String(team.id));}
      const [results,overrides]=await Promise.all([readResults(event.providerRef,scope),readOverrides(event.providerRef,scope)]);
      if(!results)return;
      // Only a bracket run that was over before the cutoff: its last game started at least a game's
      // length earlier. A run with a game of unknown time can't be dated, so it doesn't count.
      const runGames=(Object.values(results.bracketGames||{}).flat() as Raw[]).filter(g=>String(g.topId)===String(team.id)||String(g.botId)===String(team.id));
      const starts=runGames.map(g=>Date.parse(tournamentTimestamp(g.time)||''));
      if(!starts.length||!starts.every(Number.isFinite))return;
      if(!(Math.max(...starts)+GAME_LENGTH<=Date.parse(cutoff)))return;
      const finish=placementFinish(teamPlacement(structure,results,String(team.id),overrides||{}),structure.meta?.name||event.name||eventKey,norcal?topNorcalBracket(structure):undefined);
      if(!finish)return;
      finishes.push(finish);
      // NorCal's own list skips this event only once its finish came from the brackets here.
      if(norcal&&structure.meta?.eventId)scheduled.add(String(structure.meta.eventId));
    }catch{complete=false;}
  }));
  const ids=known.size?known:matched;
  // More than one id means conflicting identities, so trust none.
  const finishId=ids.size===1?[...ids][0]:null;
  // The report header's NorCal team needs NorCal's own word or a GameChanger link: this NorCal
  // tournament's id (even when a saved identity disagrees), else a saved NorCal identity, else the
  // one team other NorCal tournaments linked to the same GameChanger page. A name match never
  // names it.
  const only=matched.size===1?[...matched][0]:null;
  const profileId=current?.meta?.provider==='norcal'?String(opponent.id):identityId||(only&&linked.has(only)?only:null);
  const lookup=(id:string)=>within((fetchTeamStats(id) as Promise<Raw|null>).catch(()=>null),NORCAL_WAIT);
  const [stats,other]=await Promise.all([finishId?lookup(finishId):null,profileId&&profileId!==finishId?lookup(profileId):null]);
  if(finishId){
    if(!stats)complete=false;
    finishes.push(...norcalFinishes(stats?.tournaments,scheduled,cutoff));
  }
  const profile=profileId===finishId?stats:other;
  if(profileId&&!profile)complete=false;
  return {finishes,norcal:profileId?{id:profileId,level:profile?.classLabel||null}:null,complete};
}
