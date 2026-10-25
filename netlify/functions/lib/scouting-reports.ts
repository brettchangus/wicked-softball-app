import { createHash } from 'node:crypto';
import { collectGameChanger, GameChangerError } from './gamechanger-scouting.ts';
import { applyOpponentClasses, classificationKey, classifyCompetition, competitionClassInput, knownOpponentPublicId, matchCompetitionTeam, opponentClassGroup, scoutingAge } from './scouting-levels.ts';
import { scoutingMetrics, scoutingReportStaleReason, wasPlayed, scoutingStartDate, SCOUTING_METHOD_VERSION } from './scouting-metrics.ts';
import { teamSummary } from './scouting-summary.ts';
import { starRating, seasonScouting, structureTeams } from './scouting-rating.ts';
import { scoutingOpponents, tournamentTimestamp } from './scouting-opponents.ts';
import { readScoutingReport, scanScoutingReports, syncScoutingIndex, saveScoutingReport, deleteScoutingReport } from './scouting-store.ts';
import { readStructure, readResults, readOverrides, mergeSnapshot } from './snapshot.js';
import { loadDirectoryMatches } from './team-directory.js';
import { loadTeamDisplay } from './team-display.js';
import { standingClasses, teamClassSource, teamDisplayMap } from './opponents.js';
import { classCode } from './divisions.js';
import { searchGameChangerTeams } from './gamechanger-search.js';
import { fetchTeamProfile, fetchTeamStats } from './norcal.js';
import { readSeason, writeSeason } from './snapshot.js';
import type { Opponent, SavedReport, Collection, Level, TeamRating, ScoutGame } from './scouting-types.ts';
type Raw=Record<string,any>;
// Admin view of scouting for the selected tournament: eligible opponents and saved reports with
// their needs-refresh flag. Also repairs the snapshot's report index.
// The tournament as every scouting reader sees it: the merged snapshot, posted standings included, so a
// team's class (teamClassSource) resolves the same in the admin view and the public report. null
// before setup.
export async function readScoutingSnapshot(context:Raw):Promise<Raw|null>{
  return mergeSnapshot(await readStructure(context.eventId,context.scope),await readResults(context.eventId,context.scope),await readOverrides(context.eventId,context.scope));
}
export async function scoutingState(context:Raw){
  const snap=await readScoutingSnapshot(context);
  const eligibility=scoutingOpponents(snap||{});
  if(snap){
    const directory=await loadDirectoryMatches(context,snap);
    const display=await loadTeamDisplay(context.scope,snap,{opponents:context.event.config?.opponents,links:directory.links,directoryTeams:directory.teams}) as Record<string,Raw>;
    for(const opponent of eligibility.opponents)opponent.name=display[opponent.id]?.label||opponent.name;
  }
  // The admin path rescans every report (it is rarely loaded) and repairs the snapshot's index.
  const summaries=await scanScoutingReports(context.scope);
  await syncScoutingIndex(context.scope,summaries);
  const links=snap?(await loadDirectoryMatches(context,snap)).links as Record<string,string>:null;
  const reports=summaries.map(report=>({...report,stale:scoutingReportStaleReason(report,links,context.season.teamConfig?.scoutingIdentityRev)!==null}));
  return {snap,eligibility,reports};
}
// Collects an opponent's GameChanger games and box scores, classifies each team they played as B or
// C, and assembles the saved report with head-to-head history. Class views are not stored; every
// reader derives them from the saved games (presentScoutingReport).
export async function buildScoutingReport(context:Raw,snap:Raw,opponent:Opponent,token:string,prior:SavedReport|null,now=new Date().toISOString()):Promise<SavedReport>{
  const directory=await loadDirectoryMatches(context,snap);
  const links=directory.links as Record<string,string>;
  const url=links[opponent.id];
  if(!url)throw new Error('Set the GameChanger link for '+opponent.name+' in Opponents first.');
  const cutoff=opponent.firstPitch&&Date.parse(opponent.firstPitch)<Date.parse(now)?opponent.firstPitch:now;
  const targetDate=opponent.firstPitch||snap.meta.dates?.[0]||now;
  const seasonLabel=String(context.season.name||'')+' '+String(context.season.key||'');
  const expectedSeason=/\b(spring|summer|fall)\b/i.exec(seasonLabel)?.[1]?.toLowerCase();
  const expectedYear=Number(/\b(20\d\d)\b/.exec(seasonLabel)?.[1]||targetDate.slice(0,4));
  const startDate=scoutingStartDate(targetDate,expectedYear,expectedSeason);
  const collection=await collectGameChanger(url,token,{cutoff,boxSince:startDate});
  if(prior?.collection.games.some(g=>g.boxScore&&Date.parse(g.date)>=Date.parse(startDate))&&collection.games.some(g=>g.kind==='competitive'&&Date.parse(g.date)>=Date.parse(startDate))&&!collection.games.some(g=>g.boxScore&&Date.parse(g.date)>=Date.parse(startDate)))throw new GameChangerError('Player box scores could not be refreshed. The previous report was kept; check GameChanger access.');
  if((collection.year&&collection.year!==expectedYear)||(expectedSeason&&collection.seasonName&&collection.seasonName.toLowerCase()!==expectedSeason))throw new GameChangerError('The saved GameChanger link is for a different season. Correct it in Opponents first.');
  const display=await loadTeamDisplay(context.scope,snap,{opponents:context.event.config?.opponents,links,directoryTeams:directory.teams,ownUrl:context.season.teamConfig?.gameChangerUrl||''}) as Record<string,Raw>;
  const teams:Raw[]=Object.values(snap.pools||{}).flatMap((p:any)=>p.teams||[]);
  const seasonClasses=new Map<string,Raw[]>();
  // Reuse verified GameChanger-to-NorCal links from other tournaments in this same season.
  for(const [eventKey,event] of Object.entries(context.season.events||{}) as [string,Raw][]){
    if(eventKey===context.eventKey)continue;
    const structure=await readStructure(event.providerRef,{...context.scope,eventKey} as any);
    if(structure?.meta?.provider!=='norcal')continue;
    const eventLinks=(await loadDirectoryMatches({...context,event,eventKey},structure)).links as Record<string,string>;
    for(const t of Object.values(structure.pools||{}).flatMap((p:any)=>p.teams||[]) as Raw[]){
      const publicId=/\/teams\/([\w-]+)/.exec(eventLinks[t.id]||'')?.[1];
      if(!publicId)continue;
      const known=seasonClasses.get(publicId)||[];
      known.push({...t,source:'https://norcal.registerplay.com/pages/team/detail/'+t.id});seasonClasses.set(publicId,known);
    }
  }
  const classifications=new Map<string,{level:Level;publicId:string|null;teamId:string|null}>();
  const standing=standingClasses(snap) as Record<string,string>;
  const identityCache=new Map<string,Raw>();
  // Match through current-season configured identities, never infer a provider class from a name alone.
  const candidateNames=context.event.config?.gameChangerTeamNames||{};
  const ownUrl=context.season.teamConfig?.gameChangerUrl;
  if(ownUrl)links[String(snap.meta.providerTeamId)]=ownUrl;
  let own:Collection|null=null;
  if(ownUrl){
    try{own=await collectGameChanger(ownUrl,token,{cutoff,boxLimit:0});}
    catch(error){if(error instanceof GameChangerError&&error.code==='gameChangerToken')throw error;}
  }
  const age=scoutingAge(context.event,context.team,snap.meta.division);
  for(const game of collection.games){
    let publicId=knownOpponentPublicId(game,{own,links,candidateNames});
    const cacheKey=classificationKey(publicId,game.opponent);
    const cached=classifications.get(cacheKey);
    if(cached){game.level=cached.level;game.opponentPublicId=cached.publicId;game.opponentTeamId=cached.teamId;continue;}
    let linked=matchCompetitionTeam(publicId,links,teams) as Raw|null;
    let evidenceGames:Collection['games']=[],evidenceSource:string|null=null;
    // Search only unresolved identities. A unique confident current-age/season result is required.
    if(!publicId){
      try{
        const hits=await searchGameChangerTeams(game.opponent,{age:age?age+'U':undefined,date:game.date,season:collection.seasonName||undefined,year:collection.year||undefined,token,state:context.team.state||'CA'});
        let confident=hits.filter((h:Raw)=>h.autoMatch);
        const paired=/^(.+?)\s+([A-Za-z]+\/[A-Za-z]+)\s+\d+\s*U\b/i.exec(game.opponent);
        if(!confident.length&&paired){
          const fallback=await searchGameChangerTeams(game.opponent,{query:paired[1]+' '+paired[2].split('/')[0],age:age?age+'U':undefined,date:game.date,season:collection.seasonName||undefined,year:collection.year||undefined,token,state:context.team.state||'CA'});
          confident=fallback.filter((h:Raw)=>h.autoMatch);
        }
        if(confident.length===1){publicId=/\/teams\/([\w-]+)/.exec(confident[0].url)?.[1]||null;linked=matchCompetitionTeam(publicId,links,teams) as Raw|null;}
      }catch(error){if(/token expired|invalid/i.test((error as Error).message))throw new GameChangerError('GameChanger token expired or invalid.','gameChangerToken');}
    }
    // This tournament's team, kept on the game so the Opponents class applies when it is read. Taken
    // after the name search (which can find it) and before `linked` may move to another tournament's team.
    const teamId=linked?String(linked.id):null;
    const classOf=(t:Raw|null)=>t?teamClassSource(t,standing[String(t.id)]) as {level:string;source:string}|null:null;
    const hasClass=(t:Raw|null)=>!!classOf(t);
    if(publicId&&!hasClass(linked)){
      const known=seasonClasses.get(publicId)||[];
      const levels=new Set(known.map(t=>opponentClassGroup(classOf(t)?.level)).filter(Boolean));
      if(levels.size===1)linked=known.find(hasClass)||linked;
    }
    if(publicId&&!hasClass(linked)){
      try{const evidence=await collectGameChanger('https://web.gc.com/teams/'+publicId,token,{cutoff,boxLimit:0});evidenceGames=evidence.games;evidenceSource='https://web.gc.com/teams/'+publicId+'/schedule';}
      catch(error){if(error instanceof GameChangerError&&error.code==='gameChangerToken')throw error;}
    }
    let identity=publicId?context.season.teamConfig?.scoutingIdentities?.[publicId]:null;
    if(identity&&publicId&&identity.basis!=='Coach classification'){
      if(identityCache.has(publicId))identity=identityCache.get(publicId);
      else{
        identity={...identity};
        const providerId=/\/pages\/team\/detail\/(\d+)/.exec(identity.source||'')?.[1];
        const current=providerId?await fetchTeamStats(providerId):null;
        const currentLevel=current?.level||current?.registeredLevel;
        if(/^(?:\d+[- ]?)?[BC]$/i.test(currentLevel||'')){identity.level=/C$/i.test(currentLevel)?'C':'B';identity.basis=current?.level?'Provider classification':'Provider registration';}
        else game.warnings.push('Saved NorCal classification could not be refreshed; using the last verified class.');
        identityCache.set(publicId,identity);
      }
    }
    // A saved identity names its own class; otherwise the team's class comes from the shared order.
    const provider=identity?{level:identity.basis==='Provider classification'?identity.level:undefined,registeredLevel:identity.basis==='Provider registration'?identity.level:undefined}
      :competitionClassInput(linked,linked?standing[String(linked.id)]:null);
    const level=classifyCompetition({override:identity?.basis==='Coach classification'?identity.level:undefined,...provider,games:evidenceGames,source:identity?.source||linked?.source||(linked&&snap.meta.provider==='norcal'?'https://norcal.registerplay.com/pages/team/detail/'+linked.id:evidenceSource)});
    if(identity){level.reason=identity.reason;level.reviewedAt=identity.reviewedAt;}
    classifications.set(cacheKey,{level,publicId,teamId});game.opponentPublicId=publicId;game.opponentTeamId=teamId;game.level=level;
    // A name search that found an id also answers later games that carry that id.
    if(publicId)classifications.set(classificationKey(publicId,game.opponent),{level,publicId,teamId});
  }
  const opponentName=display[opponent.id]?.label||opponent.name;
  // History is limited to verified same-season provider identities and explicitly disclosed.
  const meetings:Raw[]=(snap.wicked?.games||[]).filter((g:Raw)=>String(g.oppId)===opponent.id&&Date.parse(tournamentTimestamp(g.date)||'')>=Date.parse(startDate)&&Date.parse(tournamentTimestamp(g.date)||'')<Date.parse(cutoff)).map((g:Raw)=>({...g,date:tournamentTimestamp(g.date)}));
  for(const g of collection.games.filter(g=>own&&g.opponentPublicId===own.publicId&&Date.parse(g.date)>=Date.parse(startDate))){
    const score=g.ra+'-'+g.rf;
    if(!meetings.some(m=>String(m.date).slice(0,10)===g.date.slice(0,10)&&m.score===score))meetings.push({date:g.date,opp:collection.name,oppId:opponent.id,score,res:g.rf>g.ra?'L':g.rf<g.ra?'W':'T',event:'Opponent GameChanger scorebook',source:g.source});
  }
  meetings.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const warnings=[...collection.warnings,'Season classification uses posted scored games; unmarked scrimmages may require coach review.'];
  const rating=await scoutedTeamRating(snap,opponent.id);
  return {startDate,rating,levelRevision:context.season.teamConfig?.scoutingIdentityRev||null,opponent:{...opponent,name:opponentName},generatedAt:prior?.generatedAt||now,refreshedAt:prior?now:null,asOf:cutoff,methodVersion:SCOUTING_METHOD_VERSION,sourceUrl:url,sourceFingerprint:createHash('sha256').update(JSON.stringify({method:SCOUTING_METHOD_VERSION,startDate,collection:collection.games,cutoff})).digest('hex'),collection,history:{scope:'Recorded current-season meetings',meetings,warnings:['Other seasons and unlinked scorebooks are not included.']},warnings};
}
// The scouted team's own class and rank for the Overview summary: NorCal's team profile in a
// NorCal tournament, otherwise the level the tournament structure carries (no rank).
async function scoutedTeamRating(snap:Raw,teamId:string):Promise<TeamRating|null>{
  if(snap.meta?.provider==='norcal'){
    const stats=await fetchTeamStats(teamId).catch(()=>null);
    const level=classCode(stats?.level)||classCode(stats?.registeredLevel);
    if(level)return {level,rank:stats?.rank??null,rankOf:stats?.rankOf??null,source:'NorCal'};
  }
  const team=(Object.values(snap.pools||{}) as Raw[]).flatMap(p=>p.teams||[]).find((t:Raw)=>String(t.id)===teamId);
  const known=team?teamClassSource(team,(standingClasses(snap) as Record<string,string>)[teamId]) as {level:string;source:string}|null:null;
  return known?{level:known.level,rank:null,rankOf:null,source:known.source==='tournament'?'the tournament':'NorCal'}:null;
}
// A saved report as it is shown: views rebuilt from the saved games (so a change to which games
// count, like an unplayed 0-0, reaches saved reports without a GameChanger refresh), a scorebook
// note for each unplayed game, the Overview summary, and the star rating with this season's
// finishes. Every reader of a saved report goes through this, so they all show the same thing.
// `structure` is the tournament's structure or merged snapshot (pools and meta), or null.
export async function presentScoutingReport(context:Raw,report:SavedReport,structure:Raw|null){
  const id=report.opponent.id;
  // Classes set in the Opponents editor (display overrides, this tournament only): one on the scouted
  // team wins over NorCal's for its stars and summary, and the rest apply to the games it played.
  // One equal to the team's calculated class is no override (resolveTeamDisplay drops it).
  const saved=context.event?.config?.opponents||{};
  const classes=Object.fromEntries((structure
    ?Object.entries(teamDisplayMap(structure,saved) as Record<string,Raw>).map(([teamId,row])=>[teamId,row.override?.level])
    :Object.entries(saved).map(([teamId,override])=>[teamId,(override as Raw)?.level])).filter(([,level])=>level)) as Record<string,string>;
  const startDate=report.startDate||scoutingStartDate(report.asOf,report.collection.year,report.collection.seasonName);
  const collectionGames=applyOpponentClasses(report.collection.games,classes);
  const views=Object.fromEntries(['B','C','All'].map(group=>[group,scoutingMetrics(collectionGames,group as 'B'|'C'|'All',report.asOf,startDate)]));
  const games=views.All.games as ScoutGame[];
  const day=(value:string)=>new Date(value).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'});
  const unplayed=report.collection.games.filter(g=>g.kind==='competitive'&&!wasPlayed(g)&&Date.parse(g.date)>=Date.parse(startDate)&&Date.parse(g.date)<Date.parse(report.asOf))
    .map(g=>day(g.date)+' vs '+g.opponent+': listed as 0-0 '+(g.boxScore?'but nobody batted in the box score':'with no box score')+', so it is not counted as a game.');
  const team=structureTeams(structure).find(t=>String(t.id)===id);
  const {finishes,norcal}=await seasonScouting(context,{id,name:team?.name||report.opponent.name,sourceUrl:report.sourceUrl},structure,report.asOf);
  // The header's NorCal class badge and profile link, when the opponent's NorCal team is known.
  const profile=norcal?{url:'https://norcal.registerplay.com/pages/team/detail/'+encodeURIComponent(norcal.id),level:norcal.level}:null;
  // The class is NorCal's current class (Rec included), so the stars and summary agree with the
  // badge; else the saved rating, else the tournament structure.
  const live=classCode(norcal?.level);
  // An admin class that only repeats NorCal's current one is no override, so NorCal's rating (and rank) stays.
  const set=classes[id]&&classes[id]!==live?classes[id]:null;
  // A rating saved from the tournament's level gives way to the team's NorCal class (teamClassSource).
  const known=team?teamClassSource(team,(standingClasses(structure) as Record<string,string>)[id]) as {level:string;source:string}|null:null;
  const norcalOwn=known&&known.source!=='tournament'?known.level:null;
  const savedRating=report.rating&&report.rating.source==='the tournament'&&norcalOwn?{level:norcalOwn,rank:null,rankOf:null,source:'NorCal'}:report.rating??null;
  const rating=set?{level:set,rank:null,rankOf:null,source:'the admin'}
    :live&&savedRating&&live!==savedRating.level?{...savedRating,level:live,source:'NorCal'}:savedRating;
  // Stars know B and C; a Rec team is rated (and capped) as C.
  const shown=set||live||savedRating?.level||known?.level||null;
  const level=shown==='Rec'?'C':shown;
  return {...report,startDate,collection:{...report.collection,games:collectionGames},rating,views,warnings:[...report.warnings,...unplayed],summary:teamSummary(games,rating),stars:starRating(games,level,finishes),norcal:profile};
}
// Saves (or clears) a coach-reviewed or NorCal-verified B/C class for one GameChanger team, for
// every report this season; saved reports then need a refresh.
export async function setScoutingIdentity(context:Raw,body:Raw){
  const report=await readScoutingReport(context.scope,String(body.opponentId||''));
  const publicId=String(body.publicId||'');
  const game=report?.collection.games.find(g=>g.opponentPublicId===publicId);
  if(!game||!/^[\w-]+$/.test(publicId))return {error:'Choose a verified opponent identity from a saved report.'};
  const level=String(body.level||''),reason=String(body.reason||'').trim().slice(0,500);
  let identity:Raw|null=null;
  if(level&&!reason)return {error:'Enter the reason or identity evidence for this classification.'};
  if(level==='provider'){
    const teamId=/^https:\/\/norcal\.registerplay\.com\/pages\/team\/detail\/(\d+)(?:[/?#]|$)/i.exec(String(body.source||''))?.[1];
    if(!teamId)return {error:'Enter a NorCal team profile URL.'};
    const [profile,stats]=await Promise.all([fetchTeamProfile(teamId),fetchTeamStats(teamId)]);
    const expectedAge=scoutingAge(context.event,context.team,game.opponent);
    if(!profile||!stats||(expectedAge&&String(profile.age)!==expectedAge))return {error:'The NorCal profile is unavailable or has a different age.'};
    const providerLevel=stats.level||stats.registeredLevel;
    if(!/^(?:\d+[- ]?)?[BC]$/i.test(providerLevel||''))return {error:'This NorCal profile does not have a B/C classification.'};
    identity={level:/C$/i.test(providerLevel)?'C':'B',basis:stats.level?'Provider classification':'Provider registration',source:'https://norcal.registerplay.com/pages/team/detail/'+teamId,name:game.opponent,providerName:profile.name,reason,reviewedAt:new Date().toISOString()};
  }else if(level){
    if(!['B','C'].includes(level)||!reason)return {error:'Choose B/C and enter the reason for this coach classification.'};
    identity={level,basis:'Coach classification',source:null,name:game.opponent,reason,reviewedAt:new Date().toISOString()};
  }
  const season=await readSeason(context.teamKey,context.seasonKey);
  season.teamConfig ||= {};
  season.teamConfig.scoutingIdentities={...season.teamConfig.scoutingIdentities};
  if(identity)season.teamConfig.scoutingIdentities[publicId]=identity;else delete season.teamConfig.scoutingIdentities[publicId];
  season.teamConfig.scoutingIdentityRev=new Date().toISOString()+'-'+crypto.randomUUID();
  await writeSeason(season);
  return {ok:true,identity,requiresRefresh:true};
}
// Handles the admin scouting actions: list, view, generate, refresh and delete. Builds at most one
// report per request so batches stay within the function timeout.
export async function scoutingAction(context:Raw,action:string,body:Raw){
  const {snap,eligibility,reports}=await scoutingState(context);
  if(action==='getScoutingReports')return {ok:true,...eligibility,reports};
  const id=String(body.opponentId||'');
  if(action==='viewScoutingReport'){const report=await readScoutingReport(context.scope,id);return report?(report.methodVersion===SCOUTING_METHOD_VERSION?{ok:true,report:await presentScoutingReport(context,report,snap)}:{error:'The report settings changed. Refresh this scouting report.'}):{error:'Scouting report not found.'};}
  if(action==='deleteScoutingReport'){if(!reports.some(r=>r.id===id))return {error:'Scouting report not found.'};await deleteScoutingReport(context.scope,id);return {ok:true};}
  if(!snap)return {error:'The tournament schedule is not available yet.'};
  const token=String(body.gcToken||'').trim();
  if(!token)return {error:'Enter a GameChanger token.',code:'gameChangerToken'};
  const existing=new Set(reports.map(r=>r.id));
  let targets=eligibility.opponents.filter(o=>action==='generateScoutingReports'?!existing.has(o.id):existing.has(o.id));
  if(action==='refreshScoutingReport'){
    const prior=await readScoutingReport(context.scope,id);
    if(!prior)return {error:'Scouting report not found.'};
    targets=[eligibility.opponents.find(o=>o.id===id)||prior.opponent];
  }
  // One report per request keeps manual batches within the function timeout. The client advances the queue.
  if(body.opponentId)targets=targets.filter(o=>o.id===id);
  if(targets.length>1)return {ok:true,targets:targets.map(o=>o.id)};
  const completed:string[]=[],failed:{id:string;name:string;error:string}[]=[];
  for(const opponent of targets){
    try{
      const prior=await readScoutingReport(context.scope,opponent.id);
      if(action==='generateScoutingReports'&&prior)continue;
      const report=await buildScoutingReport(context,snap,opponent,token,prior);
      await saveScoutingReport(context.scope,report);completed.push(opponent.id);
    }catch(error){
      if(error instanceof GameChangerError&&error.code==='gameChangerToken')return {error:error.message,code:error.code,completed};
      failed.push({id:opponent.id,name:opponent.name,error:error instanceof GameChangerError?error.message:error instanceof Error&&/Set the GameChanger link/.test(error.message)?error.message:'Could not generate this report. The previous report was kept.'});
    }
  }
  return {ok:true,completed,failed};
}
