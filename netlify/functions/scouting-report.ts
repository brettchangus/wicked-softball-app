import { resolveContext, contextInputFromRequest } from './lib/snapshot.js';
import { readScoutingReport } from './lib/scouting-store.ts';
import { loadDirectoryMatches } from './lib/team-directory.js';
import { scoutingReportStaleReason, type ScoutingStaleReason } from './lib/scouting-metrics.ts';
import { presentScoutingReport, readScoutingSnapshot } from './lib/scouting-reports.ts';
const STALE_MESSAGES:Record<ScoutingStaleReason,string>={
  method:'The report settings changed. Refresh this scouting report.',
  link:'Opponent link changed. Refresh this scouting report.',
  classes:'Competition classifications changed. Refresh this scouting report.',
};
// Public GET endpoint that serves one opponent's saved report, refusing a report that is out of
// date.
export default async function handler(req:Request){
  if(req.method!=='GET')return Response.json({error:'GET only'},{status:405});
  try{
    const context=await resolveContext(contextInputFromRequest(req));
    if(!context.scope)return Response.json({error:'No tournament selected.'},{status:404});
    const id=new URL(req.url).searchParams.get('opponent')||'';
    const report=await readScoutingReport(context.scope,id);
    if(!report)return Response.json({error:'Scouting report not found.'},{status:404});
    // The same merged snapshot the admin view reads, so both show the same classes.
    const structure=await readScoutingSnapshot(context);
    const links=(await loadDirectoryMatches(context,structure)).links as Record<string,string>;
    const stale=scoutingReportStaleReason({...report,id},links,context.season.teamConfig?.scoutingIdentityRev);
    if(stale)return Response.json({error:STALE_MESSAGES[stale]},{status:409});
    // Summary, star rating and views are derived on read (presentScoutingReport).
    return Response.json({report:await presentScoutingReport(context,report,structure)},{headers:{'Cache-Control':'no-store'}});
  }catch{return Response.json({error:'Scouting report is unavailable.'},{status:404});}
}
export const config={path:'/api/scouting-report'};
