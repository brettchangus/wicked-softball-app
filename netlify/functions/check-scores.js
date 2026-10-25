// Cron (every 5 min): keeps the live-results blob (L2) fresh + sends push notifications.
// - Auto-setup: (re)discovers + writes the structure blob when PUBLIC_EVENT_ID changes.
// - Window-gated: only does live work during the event date window (Pacific). The actual
//   score-pull (per-pool/bracket skipping, push on the completed transition) lives in
//   lib/scores.js so the admin "pull scores now" button can trigger it on demand too.
// - Pending schedules are rediscovered hourly, including weekdays. Published Tourney Machine
//   schedules refresh hourly in the week before play and every five minutes during the event;
//   published NorCal schedules refresh hourly from a week before play through the last day.
// - GameChanger season records (tokenless public profiles) refresh every 3 hours, and every
//   30 minutes from the tournament's first day through its last.
import { buildProviderStructure, structureIsCurrent, norcalScheduleRefreshDue, applyNorcalScheduleRefresh } from './lib/providers.js';
import { listSeasonContexts, readStructure, writeStructure, readSetupAttempt, writeSetupAttempt, clearSetupAttempt, readGameChangerRecords } from './lib/snapshot.js';
import { SETUP_VERSION } from './lib/tournament.js';
import { effectiveSelection } from './lib/context.js';
import { runScoreCheck } from './lib/scores.js';
import { linkedGameChangerRecordUrls, gameChangerRecordsRefreshDue, refreshGameChangerRecords } from './lib/gamechanger-records.js';

export default async function handler() {
  const contexts = await listSeasonContexts({ status:'active' });
  if (!contexts.length) return new Response('no active seasons', { status:200 });
  const todayPT = new Date(Date.now()).toLocaleDateString('en-CA', { timeZone:'America/Los_Angeles' });
  const outcomes = [], recordRefreshes = [];
  // Keep this sequential: provider discovery can fan out to many requests per event, and a
  // small youth-sports deployment benefits more from predictable provider load than parallelism.
  for (const context of contexts) {
    const { eventId, scope, team, event } = context;
    const selection = effectiveSelection(event);
    let structure = await readStructure(eventId, scope);
    // Records run off whatever structure is stored, before setup and the event window can skip
    // this context. They run alongside setup and the score check, never ahead of them, and are
    // collected before the tick returns.
    if (structure) recordRefreshes.push(refreshRecordsIfDue(context, structure, todayPT));
    if (!structureIsCurrent(structure, eventId, team, selection) || (structure?.meta?.schedulePending
      && Date.now() - Date.parse(structure.meta.generatedAt || 0) >= 3600000)) {
      // Only defer while there is nothing live to poll (no structure yet, or a pending schedule).
      // A published-but-outdated structure keeps retrying every tick so a transient failure
      // doesn't pause score checks for an hour mid-event.
      const attempt = !structure || structure.meta?.schedulePending ? await readSetupAttempt(scope) : null;
      if (attempt?.eventId === eventId && attempt?.setupVersion === SETUP_VERSION
        && Date.now() - Date.parse(attempt.attemptedAt) < 3600000) {
        outcomes.push(`${context.teamKey}/${context.seasonKey}: setup retry deferred`);
        continue;
      }
      try {
        await writeSetupAttempt(scope, { eventId, setupVersion:SETUP_VERSION, attemptedAt:new Date(Date.now()).toISOString() });
        structure = await buildProviderStructure(eventId, team, { providerTeamId: event?.providerTeamId, previousStructure:structure, selection });
        await writeStructure(eventId, structure, scope);
        // Only failures defer the next attempt; a success must not block a later rebuild.
        await clearSetupAttempt(scope);
      } catch (error) {
        outcomes.push(`${context.teamKey}/${context.seasonKey}: setup failed`);
        continue;
      }
    }
    if (structure.meta?.schedulePending) {
      outcomes.push(`${context.teamKey}/${context.seasonKey}: schedule pending`);
      continue;
    }
    if (norcalScheduleRefreshDue(structure, todayPT, Date.now())) {
      const checkedAt = new Date(Date.now()).toISOString();
      try {
        const next = await buildProviderStructure(eventId, team, { providerTeamId: event?.providerTeamId, previousStructure:structure, selection });
        const refresh = applyNorcalScheduleRefresh(structure, next, checkedAt);
        structure = refresh.structure;
        const { added, changed, removed } = refresh.changes;
        outcomes.push(`${context.teamKey}/${context.seasonKey}: ${refresh.applied
          ? `schedule refreshed (${added.length} added, ${changed.length} changed)`
          : `schedule has ${removed.length} removed game(s) — Re-run setup to review`}`);
      } catch (error) {
        // Advance the check time anyway, so a provider outage retries hourly rather than every tick.
        structure = { ...structure, meta:{ ...structure.meta, scheduleCheckedAt:checkedAt } };
        outcomes.push(`${context.teamKey}/${context.seasonKey}: schedule refresh failed`);
      }
      await writeStructure(eventId, structure, scope);
    }
    const dates = structure.meta?.dates || [];
    const inEvent = dates.includes(todayPT) || todayPT === structure.meta?.bracketDate;
    const daysUntil = (Date.parse(dates[0]) - Date.parse(todayPT)) / 86400000;
    const preEventRefresh = structure.meta?.provider === 'tourneymachine' && daysUntil > 0 && daysUntil <= 7
      && Date.now() - Date.parse(structure.meta.scheduleCheckedAt || 0) >= 3600000;
    if (!inEvent && !preEventRefresh) {
      outcomes.push(`${context.teamKey}/${context.seasonKey}: off-window`);
      continue;
    }
    try {
      await runScoreCheck(eventId, structure, { context });
      outcomes.push(`${context.teamKey}/${context.seasonKey}: checked`);
    } catch (error) {
      outcomes.push(`${context.teamKey}/${context.seasonKey}: score check failed`);
    }
  }
  outcomes.push(...(await Promise.all(recordRefreshes)).filter(Boolean));
  return new Response(outcomes.join('\n'), { status:200 });
}

// GameChanger season records; resolves to an outcome line, or null when nothing was due.
// Never rejects, so a GameChanger failure can't affect the rest of the tick.
async function refreshRecordsIfDue(context, structure, todayPT) {
  const label = `${context.teamKey}/${context.seasonKey}`;
  try {
    const links = await linkedGameChangerRecordUrls(context, structure);
    const dates = [...(structure.meta?.dates || []), structure.meta?.bracketDate];
    if (!gameChangerRecordsRefreshDue(await readGameChangerRecords(context.scope), links, { dates, todayPT, now:Date.now() }))
      return null;
    const result = await refreshGameChangerRecords(context.scope, links, { now:Date.now() });
    return `${label}: GameChanger records refreshed (${result.checked} checked, ${result.changed} changed, ${result.failed} failed)`;
  } catch (error) {
    return `${label}: GameChanger records refresh failed`;
  }
}

export const config = { schedule: '*/5 * * * *' };
