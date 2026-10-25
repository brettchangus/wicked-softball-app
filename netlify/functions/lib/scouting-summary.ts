import type { ScoutGame, TeamRating } from './scouting-types.ts';
// The one-to-two sentence team summary at the top of a report's Overview. Rule-based: each kind
// of observation has a condition and a priority; the summary takes the most notable observation
// about results by opponent class and the most notable one about form and margins.
type Game = Pick<ScoutGame,'date'|'rf'|'ra'|'level'>;
type Candidate = [priority:number, sentence:string];

const result=(g:Game)=>g.rf>g.ra?'W':g.rf<g.ra?'L':'T';
const count=(games:Game[],r:string)=>games.filter(g=>result(g)===r).length;
// "4-3", or "2-1-1" when there are ties.
const record=(games:Game[])=>{const t=count(games,'T');return count(games,'W')+'-'+count(games,'L')+(t?'-'+t:'');};
// Win share counting a tie as half, or null with no games.
const winShare=(games:Game[])=>games.length?(count(games,'W')+count(games,'T')/2)/games.length:null;
const score=(g:Game)=>Math.max(g.rf,g.ra)+'-'+Math.min(g.rf,g.ra);
const NUMBER_WORDS=['zero','one','two','three','four','five','six','seven','eight','nine'];
const word=(n:number)=>NUMBER_WORDS[n]||String(n);
const best=(candidates:Candidate[])=>candidates.sort((a,b)=>b[0]-a[0])[0]?.[1]||'';

// Results by opponent class, set against the team's own rating when it has one.
function classObservations(games:Game[],rating:TeamRating|null):Candidate[]{
  const b=games.filter(g=>g.level?.group==='B'),c=games.filter(g=>g.level?.group==='C');
  // A Rec team is judged against B teams as a C team would be (its stars are capped as C too).
  const level=rating?.level==='Rec'?'C':rating?.level||null;
  const rated=level?'Rated '+rating!.level+' by '+rating!.source+(rating!.rank&&rating!.rankOf?' (#'+rating!.rank+' of '+rating!.rankOf+')':''):'';
  const lastB=b.slice(0,4),recentWins=count(lastB,'W'),recentLosses=count(lastB,'L');
  const recent=lastB.length<4?'':recentWins>=3?', winning '+recentWins+' of their last 4':recentLosses>=3?', losing '+recentLosses+' of their last 4':'';
  const out:Candidate[]=[];
  if(b.length>=3){
    const share=winShare(b)!;
    // A C team holding its own against B teams, or a B team struggling against them.
    const contrast=(level==='C'&&share>=.5)||(level==='B'&&share<.4);
    if(rated)out.push([contrast?90:40,rated+(contrast?', but ':' and ')+record(b)+' against B teams'+recent+'.']);
    else out.push([recent?75:45,record(b)+' against B teams'+recent+'.']);
  }else if(rated)out.push([20,rated+'.']);
  const wins=games.filter(g=>result(g)==='W'),winsC=wins.filter(g=>g.level?.group==='C');
  if(wins.length>=2&&winsC.length/wins.length>=.75&&b.length>=2&&winShare(b)!<.5)
    out.push([80,winsC.length+' of their '+wins.length+' wins came against C teams; '+record(b)+' against B teams.']);
  if(c.length&&winShare(c)!<.5){
    if(c.length===1)out.push([60,(result(c[0])==='L'?'Lost':'Tied')+' their only game against a C team, '+score(c[0])+'.']);
    else out.push([50,record(c)+' against C teams.']);
  }
  return out;
}
// Streaks, close games and lopsided games.
function formObservations(games:Game[]):Candidate[]{
  const out:Candidate[]=[];
  const first=result(games[0]);let streak=0;
  for(const g of games){if(result(g)!==first)break;streak++;}
  if(streak>=3&&first!=='T')out.push([60+streak,(first==='W'?'Won':'Lost')+' their last '+streak+'.']);
  const close=games.filter(g=>Math.abs(g.rf-g.ra)<=2),rest=games.filter(g=>Math.abs(g.rf-g.ra)>2);
  const closeWins=count(close,'W'),closeLosses=count(close,'L');
  if(close.length>=2&&(closeWins===close.length||closeLosses===close.length)){
    const won=closeWins>0;
    let sentence=(won?'Won ':'Lost ')+(close.length===2?'both':'all '+close.length)+' of their close games'
      +(close.length<=3?' ('+close.map(score).join(close.length===2?' and ':', ')+')':'');
    // "...but lost the other three by 4 or more" when every other game went the opposite way.
    if(rest.length&&count(rest,won?'L':'W')===rest.length)
      sentence+=' but '+(won?'lost':'won')+' the other '+(rest.length===1?'game':word(rest.length))+' by '+Math.min(...rest.map(g=>Math.abs(g.rf-g.ra)))+' or more';
    out.push([65,sentence+'.']);
  }else if(close.length>=3&&close.length/games.length>=.4){
    out.push([55,close.length+' of '+games.length+' games were decided by 2 runs or less ('+record(close)+').']);
  }
  const bigWins=games.filter(g=>g.rf-g.ra>=8).length,bigLosses=games.filter(g=>g.ra-g.rf>=8).length;
  if(bigWins>=2)out.push([50,'Won '+bigWins+' games by 8 or more runs.']);
  if(bigLosses>=2)out.push([50,'Lost '+bigLosses+' games by 8 or more runs.']);
  return out;
}
// The summary for a report's games (all classes) and the team's rating; '' with no games.
export function teamSummary(games:Game[],rating:TeamRating|null=null):string{
  const sorted=[...games].sort((a,b)=>b.date.localeCompare(a.date));
  const n=sorted.length;
  if(!n)return '';
  if(n<3){
    const only=['B','C'].find(group=>sorted.every(g=>g.level?.group===group));
    return record(sorted)+' in '+n+(n===1?' game':' games')+(only?(n===1?', against a ':', both against ')+only+(n===1?' team':' teams'):'')+'. Too few games to judge.';
  }
  return [best(classObservations(sorted,rating)),best(formObservations(sorted))].filter(Boolean).join(' ');
}
