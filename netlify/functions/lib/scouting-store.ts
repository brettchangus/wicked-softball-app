import { getStore } from '@netlify/blobs';
import { strongReadsAvailable } from './snapshot.js';
import type { Scope, SavedReport, ReportSummary } from './scouting-types.ts';
// The tournament Blob store, with strong reads when the runtime supports them.
const store=()=>strongReadsAvailable()?getStore({name:'tournament',consistency:'strong'}):getStore('tournament');
// Blob key prefix shared by every report in one tournament.
const prefix=(scope:Scope)=>'v2:'+scope.teamKey+':'+scope.seasonKey+':'+scope.eventKey+':scouting:';
// Blob key for one opponent's current report.
const key=(scope:Scope,id:string)=>prefix(scope)+encodeURIComponent(id);
// One small record of every report's summary, so the public snapshot (polled by every open
// dashboard) reads a single blob instead of downloading each full report. Outside the
// `scouting:` prefix so it is never mistaken for a report.
export const scoutingIndexKey=(scope:Scope)=>'v2:'+scope.teamKey+':'+scope.seasonKey+':'+scope.eventKey+':scoutingIndex';
type ScoutingIndex={summaries:Record<string,ReportSummary>};

// The small summary of a report that the index and the dashboard need.
export function reportSummary(report:SavedReport):ReportSummary{
  return {methodVersion:report.methodVersion,id:report.opponent.id,name:report.opponent.name,generatedAt:report.generatedAt,refreshedAt:report.refreshedAt,asOf:report.asOf,sourceUrl:report.sourceUrl,levelRevision:report.levelRevision||null};
}
// Sorts summaries by opponent name.
const sorted=(rows:ReportSummary[])=>rows.sort((a,b)=>a.name.localeCompare(b.name));

// Reads one opponent's full saved report.
export async function readScoutingReport(scope:Scope,id:string):Promise<SavedReport|null>{return await store().get(key(scope,id),{type:'json'}) as SavedReport|null;}
// Reads every saved report. Used by the admin page and when no index exists yet.
export async function scanScoutingReports(scope:Scope):Promise<ReportSummary[]>{
  const rows:ReportSummary[]=[];
  // Netlify lists paginate automatically unless paginate:true is requested.
  const {blobs}=await store().list({prefix:prefix(scope)});
  for(const b of blobs){
    if(b.key.includes(':version:'))continue;
    const report=await store().get(b.key,{type:'json'}) as SavedReport|null;
    if(report)rows.push(reportSummary(report));
  }
  return sorted(rows);
}
// Report summaries for the public snapshot: one index read, or a full scan when no index exists
// yet.
export async function listScoutingReports(scope:Scope):Promise<ReportSummary[]>{
  const index=await store().get(scoutingIndexKey(scope),{type:'json'}) as ScoutingIndex|null;
  return index?sorted(Object.values(index.summaries||{})):scanScoutingReports(scope);
}
// Blobs v7 has no conditional writes, so two simultaneous saves could drop one index entry.
// The admin page rescans the reports and calls this to repair any such drift.
export async function syncScoutingIndex(scope:Scope,summaries:ReportSummary[]){
  const current=await store().get(scoutingIndexKey(scope),{type:'json'}) as ScoutingIndex|null;
  const next:ScoutingIndex={summaries:Object.fromEntries(summaries.map(s=>[s.id,s]))};
  if(JSON.stringify(sorted(Object.values(current?.summaries||{})))!==JSON.stringify(sorted([...summaries])))await store().setJSON(scoutingIndexKey(scope),next);
}
// Applies one change to the summary index, seeding it from the saved reports when it is missing.
async function updateIndex(scope:Scope,change:(summaries:Record<string,ReportSummary>)=>void){
  const current=await store().get(scoutingIndexKey(scope),{type:'json'}) as ScoutingIndex|null;
  // Without an index, start from the saved reports so older reports stay listed.
  const summaries=current?{...current.summaries}:Object.fromEntries((await scanScoutingReports(scope)).map(s=>[s.id,s]));
  change(summaries);
  await store().setJSON(scoutingIndexKey(scope),{summaries});
}
// Saves a report as the current version plus a frozen dated copy, and updates the index.
export async function saveScoutingReport(scope:Scope,report:SavedReport){
  // Reports are individually stored; writing one opponent never overwrites another.
  const version=key(scope,report.opponent.id)+':version:'+Date.now()+'-'+crypto.randomUUID();
  await store().setJSON(version,report);
  await store().setJSON(key(scope,report.opponent.id),report);
  await updateIndex(scope,summaries=>{summaries[report.opponent.id]=reportSummary(report);});
}
// Deletes an opponent's report and all its frozen copies, and removes it from the index.
export async function deleteScoutingReport(scope:Scope,id:string){
  await store().delete(key(scope,id));
  const {blobs}=await store().list({prefix:key(scope,id)+':version:'});
  await Promise.all(blobs.map(b=>store().delete(b.key)));
  await updateIndex(scope,summaries=>{delete summaries[id];});
}
