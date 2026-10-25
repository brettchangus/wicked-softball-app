import type { Counts, PlayerLine, ScoutGame } from './scouting-types.ts';
// The reporting year begins September 1 in Pacific time. Spring/summer belong to the
// preceding September; an explicit fall season can begin before September's date.
export function scoutingStartDate(referenceDate:string,year?:number|null,seasonName?:string|null):string{
  const day=new Date(referenceDate).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
  const calendarYear=year||Number(day.slice(0,4));
  const fall=seasonName?/fall/i.test(seasonName):Number(day.slice(5,7))>=9;
  return (calendarYear-(fall?0:1))+'-09-01T00:00:00-07:00';
}
export const SCOUTING_METHOD_VERSION=4;
// Why a saved report can no longer be shown, or null when it is current. The public endpoint, the
// snapshot's report list and the admin "Needs refresh" flag all use this one check. Pass
// links=null when the tournament structure is unavailable, so the link check is skipped.
export type ScoutingStaleReason='method'|'link'|'classes';
export function scoutingReportStaleReason(report:{id:string;methodVersion?:number;sourceUrl:string;levelRevision?:string|null},links:Record<string,string>|null,identityRev:string|null|undefined):ScoutingStaleReason|null{
  if(report.methodVersion!==SCOUTING_METHOD_VERSION)return 'method';
  if(links&&links[report.id]!==report.sourceUrl)return 'link';
  if((report.levelRevision||null)!==(identityRev||null))return 'classes';
  return null;
}
// Highlight thresholds. Counts scale with games so a 5-game and an 11-game report are judged
// alike; the minimums keep a two-game sample from producing highlights.
export const HIGHLIGHTS={
  hitterPaPerGame:1.5,                    // at-bats + walks per game played, to qualify
  hitsPerGame:.6, minHits:3,              // "Hitting .400+"
  xbhPerGame:.25, minXbh:2,               // "Extra-base production"
  pitcherBfPerTeamGame:4, minAppearances:2,
  minStrikeoutRate:.2, maxWalkRate:.15,   // "Strikeout leader" / "Low walk rate"
};
// A per-game count threshold, rounded up, never below the minimum.
export const perGameFloor=(perGame:number,games:number,min:number)=>Math.max(min,Math.ceil(perGame*games-1e-9));
// Divides two counts, or null when either is missing or the denominator is zero.
const ratio=(n:number|null,d:number|null)=>n!==null&&d!==null&&d>0?n/d:null;
// Sums one stat across rows, or null when any row lacks it (so a partial total is never shown).
const total=(rows:Counts[],key:string)=>rows.length&&rows.every(r=>r[key]!==null&&r[key]!==undefined)?rows.reduce((n,r)=>n+(r[key]||0),0):null;
// Adds values, or null when any is missing.
const plus=(...values:(number|null)[])=>values.every(v=>v!==null)?values.reduce<number>((n,v)=>n+(v||0),0):null;
// Median of a list of numbers, or null for an empty list.
const median=(ns:number[])=>{const s=[...ns].sort((a,b)=>a-b);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null;};
// Totals each player's batting or pitching lines across games and derives rates, qualification and
// highlight badges.
export function playerMetrics(games:ScoutGame[],kind:'hitters'|'pitchers',outings=Infinity){
  const players=new Map<string,{line:PlayerLine;rows:Counts[];dates:string[]}>();
  for(const game of games)for(const line of game[kind]){
    const p=players.get(line.id)||{line,rows:[],dates:[]};if(p.rows.length>=outings)continue;p.rows.push(line.stats);p.dates.push(game.date);players.set(line.id,p);
  }
  return [...players.values()].map(p=>{
    const counts:Counts={};
    for(const key of new Set(p.rows.flatMap(r=>Object.keys(r))))if(key!=='IP')counts[key]=total(p.rows,key);
    const n=(k:string)=>counts[k]??null;
    const ab=n('AB'),h=n('H'),bb=n('BB'),k=n('SO'),hbp=n('HBP'),sf=n('SF'),outs=n('OUTS'),bf=n('BF'),er=n('ER');
    const pa=n('PA')??plus(ab,bb,hbp,sf,n('SH'),n('CI'));
    const xbh=plus(n('2B'),n('3B'),n('HR'));
    const tb=n('TB')??(h!==null&&xbh!==null?h+(n('2B')||0)+2*(n('3B')||0)+3*(n('HR')||0):null);
    const avg=ratio(h,ab),slg=ratio(tb,ab);
    const metrics=kind==='hitters'?{avg,obp:ratio(plus(h,bb,hbp),plus(ab,bb,hbp,sf)),slg,iso:slg!==null&&avg!==null?slg-avg:null,xbh,kRate:ratio(k,pa),bbRate:ratio(bb,pa),pa}
      :{kRate:ratio(k,bf),bbRate:ratio(bb,bf),era:ratio(er===null?null:er*21,outs),whip:outs!==null&&outs>0?ratio(plus(h,bb),outs/3):null,bf,outs};
    const played=p.dates.length;
    // Hitters qualify by at-bats plus walks per game they played; pitchers by batters faced per
    // game in the report (their own appearances would let a one-inning reliever qualify).
    const qualified=kind==='hitters'?ab!==null&&ab+(bb||0)>=HIGHLIGHTS.hitterPaPerGame*played
      :bf!==null&&bf>=HIGHLIGHTS.pitcherBfPerTeamGame*games.length&&played>=HIGHLIGHTS.minAppearances;
    const badges:string[]=[];
    if(kind==='hitters'&&qualified&&h!==null&&h>=perGameFloor(HIGHLIGHTS.hitsPerGame,played,HIGHLIGHTS.minHits)&&avg!==null&&avg>=.4)badges.push('Hitting .400+');
    return {id:p.line.id,name:p.line.name,number:p.line.number,games:p.dates.length,lastAppearance:p.dates.sort().at(-1),counts,metrics,qualified,badges};
  }).sort((a,b)=>((kind==='hitters'?b.counts.AB:b.metrics.bf)||0)-((kind==='hitters'?a.counts.AB:a.metrics.bf)||0)||a.id.localeCompare(b.id));
}
// False for a game that was listed but not played: a 0-0 final whose box score shows nobody batting
// and no batters faced (a rainout left on the schedule). A 0-0 without a box score can't be told
// apart from one, so it is left out too; any other score counts.
export function wasPlayed(g:Pick<ScoutGame,'rf'|'ra'|'boxScore'|'hitters'|'pitchers'>):boolean{
  if(g.rf||g.ra)return true;
  if(!g.boxScore)return false;
  return g.hitters.some(p=>['AB','BB','HBP','SF','SH'].some(k=>(p.stats[k]||0)>0))||g.pitchers.some(p=>(p.stats.BF||0)>0);
}
// Builds one class view (B, C or All) of a report: record, runs, player tables, coverage and
// scoring tendencies for games since the start date.
export function scoutingMetrics(games:ScoutGame[],group:'B'|'C'|'All',cutoff=new Date().toISOString(),startDate=scoutingStartDate(cutoff)){
  const filtered=games.filter(g=>g.kind==='competitive'&&wasPlayed(g)&&Date.parse(g.date)>=Date.parse(startDate)&&Date.parse(g.date)<Date.parse(cutoff)&&(group==='All'||g.level?.group===group)).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  const latestDate=filtered[0]?.date;
  // Keep stored view keys compatible; every summary now covers the same date range.
  const recent=filtered,form=filtered;
  const summary=(rows:ScoutGame[])=>({games:rows.length,w:rows.filter(g=>g.rf>g.ra).length,l:rows.filter(g=>g.rf<g.ra).length,t:rows.filter(g=>g.rf===g.ra).length,rf:rows.reduce((n,g)=>n+g.rf,0),ra:rows.reduce((n,g)=>n+g.ra,0),rfPerGame:rows.length?rows.reduce((n,g)=>n+g.rf,0)/rows.length:null,raPerGame:rows.length?rows.reduce((n,g)=>n+g.ra,0)/rows.length:null,medianRF:median(rows.map(g=>g.rf)),medianRA:median(rows.map(g=>g.ra))});
  const hitters=playerMetrics(recent,'hitters'),pitchers=playerMetrics(filtered,'pitchers');
  // Qualified strength labels are relative to this roster, not age-group benchmarks.
  const extraBaseLeader=hitters.filter(p=>p.qualified&&p.metrics.slg!==null&&(p.metrics.xbh||0)>=perGameFloor(HIGHLIGHTS.xbhPerGame,p.games,HIGHLIGHTS.minXbh)).sort((a,b)=>(b.metrics.slg||0)-(a.metrics.slg||0))[0];
  if(extraBaseLeader)extraBaseLeader.badges.push('Extra-base production');
  // The pitcher leaders must also clear an absolute rate, so the best of a weak staff is not
  // labeled a strength (a 32% walk rate is never a "low walk rate").
  for(const [key,label,direction,meets] of [['kRate','Strikeout leader',-1,(r:number)=>r>=HIGHLIGHTS.minStrikeoutRate],['bbRate','Low walk rate',1,(r:number)=>r<=HIGHLIGHTS.maxWalkRate]] as const){
    const leader=pitchers.filter(p=>p.qualified&&p.metrics[key]!==null&&meets(p.metrics[key]!)).sort((a,b)=>direction*((a.metrics[key]||0)-(b.metrics[key]||0)))[0];
    if(leader)leader.badges.push(label);
  }
  const batting=form.filter(g=>g.boxScore).flatMap(g=>g.hitters.map(p=>p.stats));
  const innings=form.flatMap(g=>g.innings);
  return {group,startDate,season:summary(filtered),recent:summary(recent),form:summary(form),latestDate,hitters,pitchers,seasonHitters:playerMetrics(filtered,'hitters'),seasonPitchers:playerMetrics(filtered,'pitchers'),games:filtered,coverage:{seasonGames:filtered.length,recentBoxScores:recent.filter(g=>g.boxScore).length,recentGames:recent.length,pitchingBF:form.filter(g=>g.pitchers.length&&g.pitchers.every(p=>p.stats.BF!==null&&p.stats.BF!==undefined)).length},tendencies:{scoredFirstInning:form.filter(g=>g.innings.length&&g.innings[0]>0).length,chartedInnings:form.filter(g=>g.innings.length).length,bigInnings:innings.filter(n=>n>=3).length,innings:innings.length,walks:total(batting,'BB'),stolenBases:total(batting,'SB'),caughtStealing:total(batting,'CS'),boxGames:form.filter(g=>g.boxScore).length}};
}
