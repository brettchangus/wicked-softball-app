// Shared score-pull core: fetches the active event's pool + bracket results from NorCal,
// writes the L2 results blob (only on change), and sends push notifications on the
// `completed` transition. Used by check-scores.js (cron, window-gated) and admin.js
// (manual "pull scores now", forced). Lives under lib/ so esbuild bundles it without
// registering its own endpoint. Caller decides whether to run; this never checks the date window.
import { tourneyMachinePlacement } from './tm-placement.js';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { MY_ID, VAPID_SUBJECT } from './tournament.js';
import { isLegacySubscription } from './push.js';
import { fetchTeamStats } from './norcal.js';
import { fetchTourneyMachine, normalizeTourneyMachineIds, buildTourneyMachineStructureFromParsed, reconcileTourneyMachineStructure } from './tourneymachine.js';
import { parseEventRef } from './providers.js';
import { readResults, writeResults, readConfig, writeConfig, writeSeason, writeStructure } from './snapshot.js';
import { loadTeamDisplay } from './team-display.js';

const POOL_API    = (roundKey, n) => `https://norcal.registerplay.com/api/v1/EP/poolDisplay/false/${roundKey}/${n}/0`;
const BRACKET_API = (id) => `https://norcal.registerplay.com/api/v1/EP/Round/bracket/${id}/false`;
const fetchJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
const isFinal = st => st === 'completed' || st === 'won' || st === 'lost';
const WINDOW_MS = 15 * 60 * 1000;

// Guarded: setVapidDetails throws on missing/invalid keys. scores.js is imported by admin.js
// (which must stay up even without push configured), so a bad/absent key must not crash the
// module at load — push just no-ops later if keys are missing.
try {
  webpush.setVapidDetails(VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
} catch { /* push disabled until VAPID env is set */ }

// Bracket games in the shape the client's bracketGameData expects.
function extractBracketGames(d) {
  const games = [];
  for (const rs of (d.bracket?.roundSets || []))
    for (const round of (rs.rounds || []))
      for (const g of (round.games || [])) {
        if (!g._key) continue;
        games.push({
          key: g._key, gameNo: g.gameNo, time: g.datetime,
          topSeed: g.topSeedDisplay, botSeed: g.botSeedDisplay,
          topId: g.topTeam?.teamID || null, topName: g.topTeam?.label || null,
          botId: g.botTeam?.teamID || null, botName: g.botTeam?.label || null,
          topScore: g.topScore, botScore: g.botScore,
          status: g.topScoreStatus || null,
          fac: g.facility?.abr || null, field: g.field || null,
        });
      }
  return games;
}

// Server-side mirror of the client's getWickedBracketStatus + wickedBracketPlacement (see
// index.html). Once Wicked's bracket run is complete, classify their finish from the stored
// bracket games. Returns {label,emoji,place} or null if they have no bracket games yet or are
// still playing. Persisted to config (per event) so the season-list medal + next-game
// placement card survive switching to the next tournament (the snapshot only carries the
// active event's live bracket data, so a *past* event's result must be captured here).
function computeWickedPlacement(structure, results) {
  const myId = structure.meta?.providerTeamId || MY_ID;
  if (structure.meta?.provider === 'tourneymachine') {
    return tourneyMachinePlacement(structure.brackets || [], Object.values(results.bracketGames || {}).flat(), myId);
  }
  for (const b of structure.brackets || []) {
    const games = results.bracketGames?.[b.level] || [];
    const mine = games.filter(g => g.topId === myId || g.botId === myId);
    if (!mine.length) continue;

    if (mine.some(g => !isFinal(g.status))) return null; // still playing

    const lastGame = mine.reduce((a, c) => ((a.time || '') > (c.time || '') ? a : c));
    const iWon = lastGame.topId === myId
      ? (lastGame.topScore ?? 0) > (lastGame.botScore ?? 0)
      : (lastGame.botScore ?? 0) > (lastGame.topScore ?? 0);

    const label = `${b.label} Bracket`;

    // Winner
    if (iWon) {
      return { label, emoji: '🏆', place: '1st Place' };
    }

    // Runner-up
    const maxNo = Math.max(...games.map(g => g.gameNo || 0));
    if (lastGame.gameNo === maxNo) {
      return { label, emoji: '🏆', place: '2nd Place' };
    }

    // Third place
    if (maxNo - lastGame.gameNo === 1) {
      return { label, emoji: '🏆', place: '3rd Place' };
    }

    // Everything else: compute placement dynamically
    const placeNumber = maxNo - lastGame.gameNo + 2; 
    // Explanation:
    //   maxNo → 2nd place loss
    //   maxNo-1 → 3rd place loss
    //   maxNo-2 → 4th place loss
    //   maxNo-3 → 5th place loss
    //   etc.

    const suffix =
      placeNumber === 1 ? '1st' :
      placeNumber === 2 ? '2nd' :
      placeNumber === 3 ? '3rd' :
      `${placeNumber}th`;

    return {
      label,
      emoji: '🎖️',
      place: `${suffix} Place`
    };
  }

  return null;
}


// An admin-entered result. Saved ones carry `source:'manual'`; results entered before that flag
// existed are recognizable by a numeric place (automatic captures always use "2nd Place" text).
export const isManualPlacement = p => !!p && (p.source === 'manual' || (p.source == null && typeof p.place === 'number'));

// Capture Wicked's final placement into the event config, idempotently. `autoPlacement` always
// tracks the computed result (the admin editor shows it); `knownPlacement` — what the dashboard
// and archive read — follows it unless the admin entered a result (isManualPlacement).
export function applyCapturedPlacement(config = {}, placement) {
  const same = (a, b) => !!a && a.place === b.place && a.label === b.label;
  const manual = isManualPlacement(config.knownPlacement);
  if (same(config.autoPlacement, placement) && (manual || same(config.knownPlacement, placement))) return null;
  return { ...config, autoPlacement:placement, ...(manual ? {} : { knownPlacement:placement }) };
}

async function persistWickedPlacement(eventId, structure, results, context = null) {
  const placement = computeWickedPlacement(structure, results);
  if (!placement) return;
  if (context?.season && context?.event) {
    const next = applyCapturedPlacement(context.event.config || {}, placement);
    if (!next) return;
    context.event.config = next;
    await writeSeason(context.season);
    return;
  }
  const config = await readConfig();
  const ev = (config.events && config.events[eventId]) || {};
  const prev = ev.knownPlacement;
  if (prev && prev.place === placement.place && prev.label === placement.label) return;  // unchanged
  config.events = config.events || {};
  config.events[eventId] = { ...ev, knownPlacement: placement };
  await writeConfig(config);
}

// `subscribers` are the records built in runScoreCheck; a gone subscription is pruned by the blob
// key it was read from, so records stored under the older key format are removed too.
async function sendToAll(subscribers, payload, subsStore) {
  const results = await Promise.allSettled(
    subscribers.map(s => webpush.sendNotification(s.sub, JSON.stringify(payload)))
  );
  await Promise.all(results.map(async (r, i) => {
    const code = r.status === 'rejected' ? r.reason?.statusCode : null;
    if (code === 404 || code === 410) await subsStore.delete(subscribers[i].blobKey).catch(() => {});
  }));
}

// Fetch latest results for `eventId` given its already-loaded structure. Writes the results
// blob on change and fires push. Returns a summary { changed, pushed }.
// `force` (admin manual pull) bypasses the poolsDone/bracketsDone "already final" latches and
// the bracketDay date gate — the cron path leaves it false so it doesn't re-hit NorCal every
// minute after a bracket/pool is done, but that same latch means a NorCal-side correction made
// after we saw "all final" (they occasionally fix a bad scorekeeper entry post-game — see the
// WICKED_V note below for the pool-side precedent) is never picked back up on its own.
export async function runScoreCheck(eventId, structure, { force = false, context = null } = {}) {
  if (structure.meta?.schedulePending) return { changed:false, pushed:0, schedulePending:true };
  // Subscribers (for push) + current results (the prev state + what we update).
  const subsStore = getStore('push-subscriptions');
  const { blobs: subBlobs } = await subsStore.list();
  const subs = (await Promise.all(subBlobs.map(async b => [b.key, await subsStore.get(b.key, { type: 'json' })])))
    .filter(([, s]) => s)
    .map(([blobKey, s]) => (s.subscription
      ? { blobKey, sub:s.subscription, games:s.games || [], watches:s.watches || [], legacy:isLegacySubscription(s) }
      : { blobKey, sub:s, games:[], watches:[], legacy:true }));
  const results = await readResults(eventId, context?.scope || null);
  const activeTeamId = structure.meta?.providerTeamId || MY_ID;
  const statsTeamId = context?.team?.norcalTeamId || structure.meta?.norcalTeamId || MY_ID;
  const myName = Object.values(structure.pools || {}).flatMap(p => p.teams || [])
    .find(t => t.id === activeTeamId)?.name || context?.team?.shortName || context?.team?.name || 'Our Team';
  const pushUrl = context
    ? `/teams/${context.teamKey}/seasons/${context.seasonKey}`
    : '/';

  const watchesGame = (subscriber, key) => {
    if (context && !subscriber.legacy) return subscriber.watches.some(w =>
      w.teamKey === context.teamKey && w.seasonKey === context.seasonKey
      && w.eventKey === context.eventKey && w.gameKey === key);
    if (context && context.teamKey !== context.catalog.defaultTeamKey) return false;
    return subscriber.games.includes(key);
  };
  const followsContext = subscriber => {
    if (!context) return true;
    if (subscriber.legacy) return context.teamKey === context.catalog.defaultTeamKey;
    return subscriber.watches.some(w =>
      w.teamKey === context.teamKey && w.seasonKey === context.seasonKey
      && w.eventKey === context.eventKey);
  };

  const pushTasks = [];
  // Opponents print under the name the dashboard shows (an admin's name/coach edits). Resolved
  // on the first push only — most score checks send none.
  const pushStructure = structure;
  let displayLoad = null;
  const teamDisplay = () => (displayLoad ||= loadTeamDisplay(context?.scope || null, pushStructure, {
    opponents:context?.event?.config?.opponents, links:context?.event?.config?.gameChangerTeams,
    ownUrl:context?.season?.teamConfig?.gameChangerUrl,
  }).catch(() => ({})));
  // Push once on the completed transition, to subscribers who belled this game.
  function maybePush(key, g, prevStatus, newStatus) {
    if (!(isFinal(newStatus) && prevStatus && !isFinal(prevStatus))) return;
    const recipients = subs.filter(s => watchesGame(s, key));
    if (!recipients.length) return;
    const ts = g.topScore ?? 0, bs = g.botScore ?? 0;
    const isWicked = g.topId === activeTeamId || g.botId === activeTeamId;
    const { topId, botId, topName:providerTop, botName:providerBot } = g;
    pushTasks.push((async () => {
      const display = await teamDisplay();
      const shownName = (id, name) => (id !== activeTeamId && display[id]?.label) || name;
      const topName = shownName(topId, providerTop), botName = shownName(botId, providerBot);
      let title, body;
      if (isWicked) {
        const top = topId === activeTeamId, ws = top ? ts : bs, os = top ? bs : ts;
        const opp = top ? botName : topName;
        title = ws > os ? `✅ ${myName} Win!` : `❌ ${myName} Loss`;
        body = `${opp} ${os}\n${myName} ${ws}`;
      } else {
        title = 'Final Score';
        body = `${topName} ${ts}\n${botName} ${bs}`;
      }
      return sendToAll(recipients, { title, body, tag:key, url:pushUrl }, subsStore);
    })());
  }

  // Tourney Machine exposes the whole division as one public HTML page. Refresh its
  // schedule and results together after validating stable game identities.
  if (structure.meta?.provider === 'tourneymachine') {
    // Reuse the already-resolved provider-SIDE team id from the structure itself (set by
    // buildProviderStructure when it was discovered) as the hint — a 2-part `tm:` ref with no
    // embedded team id would otherwise throw here on every cron tick for a non-default event.
    // ⚠️ This must be `sourceProviderTeamId`, NOT `structure.meta.providerTeamId` — the latter is
    // the canonical NorCal-style id (`canonicalTeamId`, used app-wide for display/season stats);
    // `ref.providerTeamId` below is matched against `topId`/`botId` scraped straight off the TM
    // HTML page (see normalizeTourneyMachineIds), which are Tourney-Machine-internal ids — using
    // the canonical id here would make it silently match nothing and never recognize our own team.
    const ref = structure.meta.tourneyMachineRef || parseEventRef(eventId, context?.team || {}, structure.meta?.sourceProviderTeamId);
    const pulled = normalizeTourneyMachineIds(await fetchTourneyMachine(ref), ref.providerTeamId, activeTeamId);
    const fresh = await buildTourneyMachineStructureFromParsed(ref, pulled, {
      canonicalTeamId:activeTeamId, fetchTeamStatsFn:async () => structure.meta.wicked || null,
    });
    const refreshed = reconcileTourneyMachineStructure(structure, fresh);
    const structureChanged = JSON.stringify(structure) !== JSON.stringify(refreshed);
    refreshed.meta.scheduleCheckedAt = new Date().toISOString();
    await writeStructure(eventId, refreshed, context?.scope || null);
    structure = refreshed;
    const known = new Set([
      ...Object.values(structure.pools || {}).flatMap(p => (p.games || []).map(g => g.key)),
      ...(structure.brackets || []).flatMap(b => (b.frame || []).map(g => g.key).filter(Boolean)),
    ]);
    const byNo = Object.fromEntries(pulled.games.map(g => [g.gameNo, g]));
    let changed = structureChanged;
    const nextByPool = {};
    for (const key of structure.poolOrder) {
      const rows = pulled.standings.filter(s => (s.pool || 'A') === key);
      const played = rows.some(s => s.win + s.loss + s.tie > 0);
      nextByPool[key] = rows.map((s, index) => ({ ...s,
        officialPoolRank:played ? index + 1 : null,
        officialRank:played && structure.poolOrder.length === 1 ? index + 1 : null }));
    }
    if (JSON.stringify(results.standings) !== JSON.stringify(nextByPool)) changed = true;
    results.standings = nextByPool;
    for (const key of Object.keys(results.games)) if (!known.has(key)) delete results.games[key];
    for (const g of pulled.games.filter(g => /^P/i.test(g.gameNo) && known.has(g.key))) {
      const prev = results.games[g.key];
      const next = { topScore:g.topScore, botScore:g.botScore, status:g.status };
      if (JSON.stringify(prev) !== JSON.stringify(next)) changed = true;
      results.games[g.key] = next;
      maybePush(g.key, { topId:g.topId, botId:g.botId, topName:g.topName, botName:g.botName, topScore:g.topScore, botScore:g.botScore }, prev?.status, g.status);
    }
    const level = structure.brackets?.[0]?.level || 'championship';
    const previous = Object.fromEntries((results.bracketGames[level] || []).map(g => [g.key, g]));
    const bracketGames = (structure.brackets?.[0]?.frame || []).map(f => {
      const g = byNo[`B${f.gameNo}`];
      if (!g) return { ...f, status:'upcoming', topScore:null, botScore:null };
      return { ...f, key:g.key, time:g.time, fac:g.fac, field:g.field,
        topId:g.topId, topName:g.topName, botId:g.botId, botName:g.botName,
        topScore:g.topScore, botScore:g.botScore, status:g.status };
    });
    for (const g of bracketGames) {
      const prev = previous[g.key];
      maybePush(g.key, g, prev?.status, g.status);
      if (JSON.stringify(prev) !== JSON.stringify(g)) changed = true;
    }
    results.bracketGames[level] = bracketGames;
    const assigned = bracketGames.some(g => g.topId || g.botId);
    if (assigned && !results.bracketAnnounced) {
      const all = subs.filter(followsContext);
      if (all.length) pushTasks.push(sendToAll(all, { title:'🏆 Bracket Matchups Are Set!', body:'Bracket assignments are live — check your bracket now!', tag:'bracket-posted', url:pushUrl }, subsStore));
      results.bracketAnnounced = true; changed = true;
    }
    // Keep the independent NorCal season record/rank card fresh without coupling tournament identity.
    if (!results.wicked) { const w = await fetchTeamStats(statsTeamId); if (w) results.wicked = w; }
    results.updatedAt = new Date().toISOString();
    await writeResults(eventId, results, context?.scope || null);
    await persistWickedPlacement(eventId, structure, results, context);
    await Promise.allSettled(pushTasks);
    return { changed, pushed:pushTasks.length, provider:'tourneymachine' };
  }

  const threshold = new Date(Date.now() + WINDOW_MS)
    .toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }).replace(' ', 'T'); // "YYYY-MM-DDTHH:MM:SS" PT
  let changed = false, wickedChanged = false;

  // Pools — skip finished pools + pools whose next game is >15 min out.
  for (const key of structure.poolOrder || []) {
    const pool = structure.pools[key];
    if (!force && results.poolsDone[key]) continue;
    const active = (pool.games || []).some(g => {
      if (isFinal(results.games[g.key]?.status)) return false;
      return !g.time || g.time <= threshold;
    });
    if (!force && !active) continue;

    let pd;
    try { pd = await fetchJson(POOL_API(pool.roundKey, pool.poolNo)); } catch { continue; }
    const p = pd.pools?.[0];
    if (!p) continue;
    results.standings[key] = p.standings || [];
    const sched = p.schedule || [];
    let allFinal = sched.length > 0;
    for (const g of sched) {
      const prev = results.games[g._key];
      results.games[g._key] = { topScore: g.topScore, botScore: g.botScore, status: g.gameStatus };
      if (!isFinal(g.gameStatus)) allFinal = false;
      // Refresh Wicked's stats when one of their games goes final OR when an already-final
      // score is corrected (NorCal scorekeepers occasionally fix a wrong score post-game) —
      // otherwise the stale score is frozen until the next status transition (it never comes).
      if (g.topTeamID === activeTeamId || g.botTeamID === activeTeamId) {
        const becameFinal = isFinal(g.gameStatus) && !isFinal(prev?.status);
        const corrected = isFinal(g.gameStatus) && prev && (prev.topScore !== g.topScore || prev.botScore !== g.botScore);
        if (becameFinal || corrected) wickedChanged = true;
      }
      maybePush(g._key, { topId: g.topTeamID, botId: g.botTeamID, topName: g.topTeam, botName: g.botTeam, topScore: g.topScore, botScore: g.botScore }, prev?.status, g.gameStatus);
      changed = true;
    }
    if (allFinal) results.poolsDone[key] = true;
  }

  // Brackets — on the bracket day, until each is final. A bracket-ONLY event (no pool rounds)
  // is nothing but bracket games spanning every event day, so fetch them on any in-event day,
  // not just the last (bracketDate) — otherwise Saturday's bracket scores never load.
  const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const noPools = !(structure.poolOrder && structure.poolOrder.length);
  const bracketDay = noPools ? (structure.meta?.dates || []).includes(todayPT) : todayPT === structure.meta?.bracketDate;
  if (bracketDay || force) {
    for (const b of structure.brackets || []) {
      if (!force && results.bracketsDone[b.level]) continue;
      let d;
      try { d = await fetchJson(BRACKET_API(b.id)); } catch { continue; }
      const games = extractBracketGames(d);
      const prevByKey = Object.fromEntries((results.bracketGames[b.level] || []).map(g => [g.key, g]));
      results.bracketGames[b.level] = games;
      let allFinal = games.length > 0;
      for (const g of games) {
        if (!isFinal(g.status)) allFinal = false;
        if (g.topId === activeTeamId || g.botId === activeTeamId) {
          const prevG = prevByKey[g.key];
          const becameFinal = isFinal(g.status) && !isFinal(prevG?.status);
          const corrected = isFinal(g.status) && prevG && (prevG.topScore !== g.topScore || prevG.botScore !== g.botScore);
          if (becameFinal || corrected) wickedChanged = true;
        }
        maybePush(g.key, g, prevByKey[g.key]?.status, g.status);
      }
      if (allFinal) results.bracketsDone[b.level] = true;
      changed = true;
    }
    // Announce once when teams first get assigned.
    const anyAssigned = (structure.brackets || []).some(b => (results.bracketGames[b.level] || []).some(g => g.topId || g.botId));
    if (anyAssigned && !results.bracketAnnounced) {
      const all = subs.filter(followsContext);
      if (all.length) pushTasks.push(sendToAll(all, { title:'🏆 Bracket Matchups Are Set!', body:'Bracket assignments are live — check your bracket now!', tag:'bracket-posted', url:pushUrl }, subsStore));
      results.bracketAnnounced = true;
      changed = true;
    }
  }

  // Refresh Wicked's season record + NorCal rank after a Wicked game (or if not cached yet).
  // `wickedV` self-heals a stale cache after a logic change: bump WICKED_V to force one refresh
  // on the next tick, then it reverts to the change-gated path above. (v3 forces a re-pull to
  // overwrite a frozen wrong score — a SRVGAL pool game cached as 8-12 L after NorCal had a bad
  // score entered, then corrected to 2-0 W; the old transition-only gate never re-fetched it.)
  const WICKED_V = 3;
  if (wickedChanged || !results.wicked || results.wickedV !== WICKED_V) {
    const w = await fetchTeamStats(statsTeamId);
    if (w) { results.wicked = w; results.wickedV = WICKED_V; changed = true; }
  }

  results.updatedAt = new Date().toISOString();
  await writeResults(eventId, results, context?.scope || null);
  // Once Wicked's bracket finishes, capture the placement into config so the season list can
  // show its medal even after we switch to the next tournament. Cheap no-op until then.
  await persistWickedPlacement(eventId, structure, results, context);
  await Promise.allSettled(pushTasks);
  return { changed, pushed: pushTasks.length };
}
