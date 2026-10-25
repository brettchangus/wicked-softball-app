import type { Level, ScoutGame } from './scouting-types.ts';
import { effectiveSelection } from './context.js';
import { parseAge } from './divisions.js';
import { teamClassSource } from './opponents.js';


// Fewest competitive games before an opponent's results decide its class.
export const MIN_PERFORMANCE_GAMES=3;

// Decides whether a scouted team's opponent counts as B or C. A tournament, registration or coach
// class wins. Otherwise, with at least MIN_PERFORMANCE_GAMES games, it is C when 25%+ of them were
// losses by 8 or more and B when fewer were; with fewer games it is B by default.
export function classifyCompetition(input:{ level?:string|null; registeredLevel?:string|null; norcalLevel?:string|null; override?:string|null; source?:string|null; games?:ScoutGame[] }):Level {
  const games=input.games||[];
  const played=games.filter(g=>g.kind==='competitive');
  const largeLosses=played.filter(g=>g.ra-g.rf>=8).length;
  const share=played.length?largeLosses/played.length:null;
  const explicit=[input.override,input.norcalLevel,input.level,input.registeredLevel].find(v=>/^(?:\d+[- ]?)?[BC]$/i.test(v||''));
  if(explicit) return {group:/C$/i.test(explicit)?'C':'B',basis:input.override?'Coach classification':explicit===input.norcalLevel?'NorCal classification':input.level?'Provider classification':'Provider registration',source:input.source||null,games:played.length,largeLosses,share};
  const likelyC=share!==null&&share>=.25;
  const basis=played.length<MIN_PERFORMANCE_GAMES?'B by default':likelyC?'Likely C':'Likely B';
  return {group:basis==='Likely C'?'C':'B',basis,source:input.source||null,games:played.length,largeLosses,share};
}

// A class set in the Opponents editor (config.opponents[teamId].level: B, C or Rec) as a scouting
// group. Rec counts with C, the lower group; anything else is no class.
export const opponentClassGroup=(value:unknown):'B'|'C'|null=>value==='B'?'B':value==='C'||value==='Rec'?'C':null;

// Applies the Opponents editor's classes (provider team id → B/C/Rec) to the games against teams in
// this tournament, at read time so a change needs no report refresh. A class set for that team in
// the report's own Opponent class dialog (a coach classification, which carries reviewedAt) wins.
export function applyOpponentClasses<G extends Pick<ScoutGame,'level'|'opponentTeamId'>>(games:G[],classes:Record<string,string>):G[]{
  return games.map(game=>{
    const set=game.opponentTeamId?classes[game.opponentTeamId]:undefined;
    const group=opponentClassGroup(set);
    if(!group||!game.level||(game.level.basis==='Coach classification'&&game.level.reviewedAt))return game;
    return {...game,level:{...game.level,group,basis:'Coach classification',source:null,
      reason:set==='Rec'?'Rec, set in Opponents (counted with C)':'Set in Opponents'}};
  });
}

// The provider class classifyCompetition reads for a tournament team, decided by teamClassSource (the
// one order every surface uses: NorCal's class ahead of the pool or bracket it plays in here) and
// passed as the input whose basis names its source. Rec counts with C; A and D give no B/C group.
export function competitionClassInput(team:Record<string,any>|null|undefined,standingClass?:string|null):{norcalLevel?:string;registeredLevel?:string;level?:string}{
  const known=teamClassSource(team,standingClass) as {level:string;source:string}|null;
  const group=opponentClassGroup(known?.level);
  if(!known||!group)return {};
  return known.source==='tournament'?{level:group}:known.source==='registered'?{registeredLevel:group}:{norcalLevel:group};
}

// The tournament's age for identity checks: the detected or corrected tournament age first (a
// team playing up, or with an outdated Age setting), then the team's Age fallback, then the
// division name. Returns digits only, or null.
export function scoutingAge(event:Record<string,any>|null|undefined,team:Record<string,any>|null|undefined,division?:string|null):string|null{
  const age=[effectiveSelection(event).age,team?.agePrefix,division].map(v=>parseAge(v)).find(v=>v!=null);
  return age==null?null:String(age);
}

// The GameChanger team a game's opponent is already known to be, before any name search: the
// scorebook's own opponent id, then our own team by exact name, then a uniquely configured
// name. An explicit id always wins over a name match.
export function knownOpponentPublicId(game:Pick<ScoutGame,'opponent'|'opponentPublicId'>,{own,links,candidateNames}:{own?:{name:string;publicId:string}|null;links:Record<string,string>;candidateNames:Record<string,string>}):string|null{
  if(game.opponentPublicId)return game.opponentPublicId;
  if(own&&game.opponent===own.name)return own.publicId;
  const ids=Object.keys(links).filter(id=>candidateNames[id]===game.opponent);
  return ids.length===1?/\/teams\/([\w-]+)/.exec(links[ids[0]])?.[1]||null:null;
}
// Classification cache key: the verified id when known, so two teams sharing a display name never
// share a class. Name keys only stand in for games whose opponent has no id yet.
export const classificationKey=(publicId:string|null,name:string)=>publicId?'id:'+publicId:'name:'+name;

// Only an exact, unique current team-season link may transfer a provider class.
export function matchCompetitionTeam(publicId:string|null, links:Record<string,string>, teams:Record<string,unknown>[]):Record<string,unknown>|null {
  if(!publicId)return null;
  const ids=Object.entries(links).filter(([,url])=>/^https:\/\/web\.gc\.com\/teams\/([\w-]+)/i.exec(url||'')?.[1]===publicId).map(([id])=>id);
  return ids.length===1?teams.find(t=>String(t.id)===ids[0])||null:null;
}
