// POST /api/chat — AI assistant that answers questions about the tournament
// schedule (from the live snapshot) and the rules (from the linked Google Drive
// doc, transcribed once and cached). Calls Claude Haiku 4.5 server-side so the
// API key never reaches the browser. Per-IP rate limited to bound cost.
//
// Requires the ANTHROPIC_API_KEY env var (set in Netlify). Without it the bot
// returns a friendly 503 so the page degrades gracefully.
import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';
import {
  readStructure, readResults, readOverrides, readScopedArchive, resolveContext, mergeSnapshot,
} from './lib/snapshot.js';
import { verifyArchiveBundle } from './lib/archive.js';
import { seasonIsComplete } from './lib/context.js';
import { MY_ID } from './lib/tournament.js';

const MODEL = 'claude-haiku-4-5';
const store = () => getStore('tournament');

// --- Rate limiting (per IP, fixed 60s window) -----------------------------
const RATE_LIMIT = 12;          // questions per minute per IP
const RATE_WINDOW_MS = 60_000;

async function checkRate(ip) {
  if (!ip) return true;         // can't identify → don't block
  const key = `chatrl:${ip}`;
  const now = Date.now();
  const cur = await store().get(key, { type: 'json' }).catch(() => null);
  if (cur && now - cur.ts < RATE_WINDOW_MS) {
    if (cur.count >= RATE_LIMIT) return false;
    await store().setJSON(key, { count: cur.count + 1, ts: cur.ts }).catch(() => {});
  } else {
    await store().setJSON(key, { count: 1, ts: now }).catch(() => {});
  }
  return true;
}

// --- Rules ingestion (fetch the Drive PDF once, transcribe, cache) ---------
function driveDirectUrl(url) {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}

async function getRulesText(eventId, rulesUrl, anthropic, cacheOnly = false) {
  if (!rulesUrl) return null;
  const cacheKey = `rules:${eventId}`;
  const cached = await store().get(cacheKey, { type: 'json' }).catch(() => null);
  if (cached && cached.url === rulesUrl && cached.text) return cached.text;
  if (cacheOnly) return null;   // completed season: never re-fetch the external rules document

  try {
    const res = await fetch(driveDirectUrl(rulesUrl));
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());

    let text;
    if (ct.includes('pdf') || rulesUrl.includes('/file/d/')) {
      // Transcribe the PDF to plain text via Claude (one-time, then cached).
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
            { type: 'text', text: 'Transcribe the full text of this youth softball tournament rules document to clean plain text. Preserve headings and lists. Output only the transcription, nothing else.' },
          ],
        }],
      });
      text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    } else {
      text = buf.toString('utf8').trim();   // already text/html/markdown
    }
    if (!text) return null;
    await store().setJSON(cacheKey, { url: rulesUrl, text, ts: Date.now() }).catch(() => {});
    return text;
  } catch {
    return null;   // never let a rules-fetch failure break the bot
  }
}

// --- Context builder (compact, model-friendly) ----------------------------
const FMT = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const laDate = iso => {
  if (!iso) return '';
  const s = String(iso);
  // NorCal schedule times are NAIVE wall-clock Pacific ("2026-06-27T11:00:00", no offset). On the
  // UTC function server `new Date(...)` would read them as UTC and shift them 7h, so format the
  // literal calendar fields verbatim (via a UTC date so nothing re-converts). Strings that DO carry
  // a Z/offset (e.g. the live "current time" from toISOString()) are real instants → convert to LA.
  const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m && !hasZone) {
    const [, y, mo, d, hh, mm] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm)).toLocaleString('en-US', { timeZone: 'UTC', ...FMT });
  }
  try {
    return new Date(s).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', ...FMT });
  } catch { return s; }
};

export function buildScheduleContext(snap, team = {}) {
  const m = snap.meta || {};
  const myId = m.providerTeamId || MY_ID;
  const lines = [];
  lines.push(`Tournament: ${m.name || 'Tournament'}`);
  if (m.dates?.length) lines.push(`Dates: ${m.dates.join(', ')}`);
  if (m.venue) lines.push(`Venue: ${[m.venue.name, m.venue.city, m.venue.address].filter(Boolean).join(', ')}`);
  if (m.division) lines.push(`Division: ${m.division}`);
  if (m.sourceUrl) lines.push(`Tournament page: ${m.sourceUrl}`);
  lines.push(`Our team is "⟦TEAM⟧"${team.subtitle ? ` (${team.subtitle})` : ''}.`);
  if (m.schedulePending) {
    // Before the provider publishes, there are no games, fields, opponents, or pools to report.
    lines.push('SCHEDULE STATUS: NOT PUBLISHED YET. Game times, fields, opponents, pools, and brackets are not available; the dashboard updates automatically once the tournament posts them.');
  }
  if (m.ast?.teams?.length) {
    const where = [m.ast.region, m.division, m.ast.location].filter(Boolean).join(', ');
    lines.push(`Registered teams${where ? ` (${where})` : ''}, ${m.ast.teams.length}: ${m.ast.teams.join('; ')}`);
  }
  const w = snap.wicked || m.wicked;
  if (w) lines.push(`⟦TEAM⟧ season record: ${w.season || '0-0'}; ${w.rank != null ? `NorCal rank #${w.rank}${w.rankOf != null ? ` of ${w.rankOf}` : ''}` : 'no NorCal rank yet'}.`);
  lines.push('');

  for (const key of (snap.poolOrder || Object.keys(snap.pools || {}))) {
    const pool = snap.pools[key];
    if (!pool) continue;
    lines.push(`=== ${pool.label || 'Pool ' + key} ===`);
    if (pool.teams?.length) {
      lines.push('Teams: ' + pool.teams.map(t =>
        `${t.name}${t.sr ? ` (season ${t.sr})` : ''}${t.id === myId ? ' [US]' : ''}`).join('; '));
    }
    if (pool.standings?.length) {
      lines.push('Standings: ' + pool.standings.map(s =>
        `${s.team || s.name || s.tn} ${s.record || ''}${s.PF != null ? ` (PF ${s.PF}/PA ${s.PA})` : ''}`).join('; '));
    }
    for (const g of (pool.games || [])) {
      const r = snap.results?.[g.key] || {};
      let score = '';
      if (r.topScore != null && r.botScore != null) score = ` — ${r.topScore}-${r.botScore}`;
      // Manual admin overrides use status "won"/"lost" (not "completed"), so treat those as final too.
      const fin = r.status === 'completed' || r.status === 'won' || r.status === 'lost';
      const status = fin ? 'FINAL' : (r.status && r.status !== 'upcoming' ? 'LIVE' : '');
      const us = (g.hid === myId || g.aid === myId) ? ' [⟦TEAM⟧ game]' : '';
      lines.push(`  • ${laDate(g.time)} — ${g.hn} vs ${g.an}${g.field ? ` @ ${g.facName || ''} ${g.field}` : ''}${score}${status ? ` [${status}]` : ''}${us}`);
    }
    lines.push('');
  }

  if (snap.brackets?.length || (snap.brackets && Object.keys(snap.brackets).length)) {
    const brs = Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets);
    lines.push('Bracket tiers: ' + brs.map(b => `${b.label} (${b.size} teams)`).join(', '));
    if (m.bracketDate) lines.push(`Bracket play: ${m.bracketDate}`);
  }

  // Bracket games + scores (so the bot can answer "who won the X bracket"). The dashboard's
  // bracketGames feed; `won`/`lost` are relative to the top team, `completed` decides by score.
  const bg = snap.bracketGames || {};
  if (Object.keys(bg).length) {
    const brs = Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets || {});
    const labelFor = lvl => (brs.find(b => b.level === lvl)?.label) || lvl;
    const isFinal = st => st === 'completed' || st === 'won' || st === 'lost';
    const winnerOf = g => {
      if (!isFinal(g.status)) return null;
      const ts = g.topScore ?? 0, bs = g.botScore ?? 0;
      if (g.status === 'completed' && ts === bs) return null;        // tie → no single winner
      const topWon = g.status === 'won' ? true : g.status === 'lost' ? false : ts > bs;
      return topWon ? g.topName : g.botName;
    };
    lines.push('');
    lines.push('=== BRACKET RESULTS ===');
    for (const [lvl, gamesRaw] of Object.entries(bg)) {
      const games = [...(gamesRaw || [])].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
      if (!games.length) continue;
      lines.push(`-- ${labelFor(lvl)} bracket --`);
      for (const g of games) {
        const top = g.topName || (g.topSeed ? `Seed ${g.topSeed}` : 'TBD');
        const bot = g.botName || (g.botSeed ? `Seed ${g.botSeed}` : 'TBD');
        const score = (g.topScore != null && g.botScore != null) ? ` — ${g.topScore}-${g.botScore}` : '';
        const status = isFinal(g.status) ? 'FINAL' : (g.status && g.status !== 'yet2Play' ? 'LIVE' : 'upcoming');
        const win = winnerOf(g);
        lines.push(`  • ${laDate(g.time)} — ${top} vs ${bot}${score} [${status}]${win ? ` — winner: ${win}` : ''}`);
      }
      // Champion is unambiguous only once the whole bracket is decided.
      if (games.every(g => isFinal(g.status))) {
        const champ = winnerOf(games[games.length - 1]);
        if (champ) lines.push(`  → ${labelFor(lvl)} bracket champion: ${champ}`);
      }
    }
  }

  const frameCtx = buildBracketFrameContext(snap);
  if (frameCtx) { lines.push(''); lines.push(frameCtx); }

  const projection = buildBracketProjection(snap);
  if (projection) { lines.push(''); lines.push(projection); }

  const scenarios = buildWickedScenarioContext(snap);
  if (scenarios) { lines.push(''); lines.push(scenarios); }
  return lines.join('\n');
}

// The season's tournament list (the public schedule), so the bot can answer "what's our next
// tournament / when is X / where is Y". Status is from each row's calendar dates in Pacific time.
export function buildSeasonScheduleContext(seasonData = [], { currentKey = null, today = null } = {}) {
  const rows = (seasonData || []).filter(row => row?.name);
  if (!rows.length) return '';
  const lines = ['=== SEASON TOURNAMENT SCHEDULE ==='];
  for (const row of rows) {
    const start = row.startDate || null, end = row.endDate || row.startDate || null;
    const status = row.key && row.key === currentKey ? 'CURRENT TOURNAMENT'
      : today && end && end < today ? 'completed'
      : today && start && start > today ? 'upcoming'
      : today && start && end ? 'in progress' : null;
    const bits = [row.dates, row.location, status, row.finish ? `finish ${placeText(row.finish) || row.finish}` : null];
    lines.push(`  • ${row.name} — ${bits.filter(Boolean).join('; ')}`);
  }
  return lines.join('\n');
}

const seasonRowEventId = row => {
  const url = row?.url || '';
  const nc = url.match(/\/event\/(\d+)/)?.[1];
  if (nc) return nc;
  const t = url.match(/[?&]IDTournament=([^&]+)/i)?.[1];
  const d = url.match(/[?&]IDDivision=([^&]+)/i)?.[1];
  return t && d ? `tm:${t}:${d}` : null;
};
const placeText = place => {
  if (place == null || place === '') return null;
  const n = parseInt(place, 10);
  if (!Number.isFinite(n)) return String(place);
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1:'st', 2:'nd', 3:'rd' }[n % 10] || 'th');
  return `${n}${suffix} Place`;
};

// Full Wicked-only game history for the completed-season assistant. NorCal supplies historical
// games through `wicked.games`; the externally-hosted final tournament is reconstructed from the
// archived pool + bracket results exactly as the public Recent Results card does.
export function archivedWickedGames(snap) {
  const w = snap.wicked || snap.meta?.wicked || {};
  const games = (w.games || []).map(g => ({ ...g, eventId:String(g.eventId || ''), stage:g.stage || null }));
  const activeId = String(snap.meta?.eventId || '');
  if (!activeId || games.some(g => g.eventId === activeId)) return games;

  const myId = snap.meta?.providerTeamId || MY_ID;
  const isFinal = st => st === 'completed' || st === 'won' || st === 'lost';
  const seen = new Set();
  const add = (key, date, event, stage, isTop, topId, topName, botId, botName, topScore, botScore, status) => {
    if (!isFinal(status) || topScore == null || botScore == null || (key && seen.has(key))) return;
    if (key) seen.add(key);
    const myScore = Number(isTop ? topScore : botScore), oppScore = Number(isTop ? botScore : topScore);
    games.push({
      key, date, eventId:activeId, event, stage,
      oppId:isTop ? botId : topId,
      opp:String(isTop ? botName : topName).replace(/^\[\d+\]\s*/, ''),
      score:`${myScore}-${oppScore}`,
      res:myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'T',
    });
  };
  for (const pool of Object.values(snap.pools || {})) {
    for (const g of (pool.games || [])) {
      if (g.hid !== myId && g.aid !== myId) continue;
      const r = snap.results?.[g.key] || {};
      add(g.key, g.time, snap.meta?.name, pool.label || 'Pool play', g.hid === myId,
        g.hid, g.hn, g.aid, g.an, r.topScore, r.botScore, r.status);
    }
  }
  const bracketLabels = Object.fromEntries(
    (Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets || {}))
      .map(b => [b.level, `${b.label || b.level} bracket`]),
  );
  for (const [level, list] of Object.entries(snap.bracketGames || {})) {
    for (const g of (list || [])) {
      if (g.topId !== myId && g.botId !== myId) continue;
      add(g.key, g.time, snap.meta?.name, bracketLabels[level] || 'Bracket play', g.topId === myId,
        g.topId, g.topName, g.botId, g.botName, g.topScore, g.botScore, g.status);
    }
  }
  return games;
}

// Archived season summary for questions such as "who did we play at Billie Sue?", "what was our
// tournament record?", and "how many podiums did we have?". This is precomputed so the model reads
// facts back instead of trying to infer cross-tournament totals from the final tournament snapshot.
export function buildSeasonHistoryContext(snap, config = {}) {
  const w = snap.wicked || snap.meta?.wicked || {};
  const games = archivedWickedGames(snap);
  const seasonRows = Array.isArray(config.seasonData) ? config.seasonData : [];
  const knownTourneys = w.tournaments || [];
  const eventMeta = new Map();

  for (const row of seasonRows) {
    const id = seasonRowEventId(row);
    if (id) eventMeta.set(String(id), { id:String(id), name:row.name, dates:row.dates, location:row.location, finish:row.finish || null });
  }
  for (const t of knownTourneys) {
    const id = String(t.id || '');
    if (!id) continue;
    eventMeta.set(id, {
      ...(eventMeta.get(id) || {}), id,
      name:eventMeta.get(id)?.name || t.name || t.short,
      dates:eventMeta.get(id)?.dates || t.dates,
      finish:eventMeta.get(id)?.finish || placeText(t.place),
      record:t.record, pf:t.pf, pa:t.pa,
    });
  }
  for (const g of games) {
    if (!g.eventId) continue;
    const cur = eventMeta.get(g.eventId) || { id:g.eventId };
    if (!cur.name) cur.name = g.event || 'Tournament';
    eventMeta.set(g.eventId, cur);
  }
  for (const [idRaw, eventConfig] of Object.entries(config.events || {})) {
    const id = String(idRaw);
    const cur = eventMeta.get(id);
    if (!cur || cur.finish || eventConfig?.knownPlacement?.place == null) continue;
    cur.finish = placeText(eventConfig.knownPlacement.place);
  }
  const activeId = String(snap.meta?.eventId || '');
  if (activeId) {
    const cur = eventMeta.get(activeId) || { id:activeId };
    cur.name = cur.name || snap.meta?.name || 'Final tournament';
    const kp = config.events?.[activeId]?.knownPlacement;
    if (!cur.finish && kp?.place != null) cur.finish = placeText(kp.place);
    eventMeta.set(activeId, cur);
  }

  // Derive per-event records directly from the authoritative game log; use provider summaries only
  // when their game history is incomplete.
  const byEvent = new Map();
  for (const g of games) {
    if (!g.eventId) continue;
    if (!byEvent.has(g.eventId)) byEvent.set(g.eventId, []);
    byEvent.get(g.eventId).push(g);
  }
  for (const [id, list] of byEvent) {
    const cur = eventMeta.get(id) || { id, name:list[0]?.event || 'Tournament' };
    const wins = list.filter(g => g.res === 'W').length;
    const losses = list.filter(g => g.res === 'L').length;
    const ties = list.filter(g => g.res === 'T').length;
    cur.record = `${wins}-${losses}${ties ? `-${ties}` : ''}`;
    eventMeta.set(id, cur);
  }

  const orderedIds = [];
  for (const row of seasonRows) {
    const id = seasonRowEventId(row);
    if (id && !orderedIds.includes(String(id))) orderedIds.push(String(id));
  }
  [...games].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach(g => {
    if (g.eventId && !orderedIds.includes(g.eventId)) orderedIds.push(g.eventId);
  });
  for (const id of eventMeta.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);

  const finalStats = config.seasonFinalStats || w;
  const lines = [
    '=== ⟦TEAM_UP⟧ ARCHIVED SEASON HISTORY ===',
    'Season status: COMPLETE. There is no active tournament and no next game.',
    `Final season record: ${finalStats.season || w.season || 'unknown'}.`,
    `Final CA-NorCal rank: ${finalStats.rank != null ? `#${finalStats.rank} of ${finalStats.rankOf ?? '?'}` : 'unknown'}.`,
    '',
    'TOURNAMENT SUMMARY (chronological):',
  ];
  for (const id of orderedIds) {
    const t = eventMeta.get(id); if (!t) continue;
    const bits = [t.dates, t.location, t.record ? `⟦TEAM⟧ record ${t.record}` : null, t.finish ? `finish ${placeText(t.finish) || t.finish}` : null];
    if (t.pf != null && t.pa != null) bits.push(`runs ${t.pf} for / ${t.pa} against`);
    lines.push(`  • ${t.name || 'Tournament'} — ${bits.filter(Boolean).join('; ')}`);
  }
  lines.push('', '⟦TEAM_UP⟧ GAME LOG (newest first):');
  [...games].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).forEach(g => {
    lines.push(`  • ${laDate(g.date)} — ${g.event || eventMeta.get(g.eventId)?.name || 'Tournament'}${g.stage ? `, ${g.stage}` : ''} — ${g.res || '?'} ${String(g.score || '').replace(/-/g, '–')} vs ${g.opp || 'unknown opponent'}`);
  });
  return lines.join('\n');
}

// When NorCal publishes the full bracket FRAME with teams already placed (notably BRACKET-ONLY
// tournaments — no pool play — but also any event once its bracket is posted), the flat BRACKET
// RESULTS list above doesn't express the TREE: who advances to play whom. Without that the bot can't
// answer "who do we play if we beat X / where do we go if we win". This mirrors the dashboard's frame
// renderer + `wickedNextPaths()` (index.html): for each game it resolves both slots (assigned team,
// seed, or winner/loser-of feed) and annotates where the winner and loser advance; then it precomputes
// Wicked's next-game win/lose opponents (or resulting final place). Feeds are signed game refs:
// >0 = winner of |n|, <0 = loser of |n| (the consolation/placement path); abs(gameNo) is unique across
// the bracket, and a negative gameNo marks a placement game. Returns text, or null when no frame is
// posted yet (so it stays out of the way pre-bracket, where BRACKET PROJECTION handles seeding).
export function buildBracketFrameContext(snap) {
  const myId = snap.meta?.providerTeamId || MY_ID;
  const brackets = Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets || {});
  const framed = brackets.filter(b => Array.isArray(b.frame) && b.frame.length);
  if (!framed.length) return null;

  const isFinal = st => st === 'completed' || st === 'won' || st === 'lost';
  const liveOf = lvl => snap.bracketGames?.[lvl] || [];
  const liveByNo = lvl => { const m = {}; for (const g of liveOf(lvl)) if (g.gameNo != null) m[Math.abs(g.gameNo)] = g; return m; };
  // Only emit once at least one slot is a concrete team (bracket-only events place teams at setup;
  // pool events leave the frame as seeds/feeds until the bracket is actually posted).
  const hasAssigned = framed.some(b => b.frame.some(g => g.topId || g.botId) || liveOf(b.level).some(g => g.topId || g.botId));
  if (!hasAssigned) return null;

  const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const resultOf = (games, gameNo) => {
    const lv = (games || []).find(g => g.gameNo != null && Math.abs(g.gameNo) === Math.abs(gameNo));
    if (!lv || !isFinal(lv.status)) return null;
    const topWon = lv.status === 'won' ? true : lv.status === 'lost' ? false : (lv.topScore ?? 0) > (lv.botScore ?? 0);
    return { winner: topWon ? { id: lv.topId, name: lv.topName } : { id: lv.botId, name: lv.botName },
             loser:  topWon ? { id: lv.botId, name: lv.botName } : { id: lv.topId, name: lv.topName } };
  };
  const slotLabel = (seed, gameRef) => gameRef != null
    ? (gameRef > 0 ? `Winner of G${gameRef}` : `Loser of G${Math.abs(gameRef)}`)
    : (seed != null ? `Seed ${seed}` : 'TBD');
  // Resolve a slot → { team:{id,name,seed?} } (concrete) or { label } (seed/feed placeholder).
  const resolveSlot = (b, games, seed, id, name, gameRef) => {
    if (id) return { team: { id, name, seed: seed || null } };
    const seeds = b.teams || [];
    if (seed && seeds[seed - 1]) return { team: seeds[seed - 1] };
    if (gameRef != null) { const r = resultOf(games, gameRef); if (r) return { team: gameRef > 0 ? r.winner : r.loser }; }
    return { label: String(name || '').trim() || slotLabel(seed, gameRef) };
  };
  const slotName = s => s.team
    ? `${s.team.seed ? `#${s.team.seed} ` : ''}${s.team.name || 'TBD'}${s.team.id === myId ? ' [US]' : ''}`
    : (s.label || 'TBD');

  const out = ['=== BRACKET STRUCTURE (matchups + advancement; "G#" = game number) ==='];
  out.push('Each game lists its two slots and where the winner and loser advance. Trace these feeds to answer "if we beat X, who do we play next".');

  for (const b of framed) {
    const frame = b.frame;
    const games = liveOf(b.level);
    const byNoLive = liveByNo(b.level);
    out.push('');
    out.push(`-- ${b.label}${b.division ? ` (${b.division} teams)` : ''} bracket --`);
    // Championship games (gameNo>0) first, then placement/consolation (gameNo<0); each by |gameNo|.
    const ordered = [...frame].sort((x, y) =>
      ((x.gameNo < 0) - (y.gameNo < 0)) || (Math.abs(x.gameNo) - Math.abs(y.gameNo)));
    for (const g of ordered) {
      const A = Math.abs(g.gameNo);
      const a = resolveSlot(b, games, g.topSeed, g.topId, g.topName, g.topGame);
      const c = resolveSlot(b, games, g.botSeed, g.botId, g.botName, g.botGame);
      const lv = byNoLive[A];
      let score = '', winTag = '';
      if (lv && isFinal(lv.status) && lv.topScore != null && lv.botScore != null) {
        score = ` — ${lv.topScore}-${lv.botScore} FINAL`;
        const r = resultOf(games, A);
        if (r?.winner?.name) winTag = ` (winner: ${r.winner.name})`;
      }
      const winDest = frame.find(x => x.topGame === A || x.botGame === A);
      const loseDest = frame.find(x => x.topGame === -A || x.botGame === -A);
      const adv = `winner → ${winDest ? `G${Math.abs(winDest.gameNo)}` : (g.gameNo > 0 ? 'CHAMPION' : 'final placement')}, loser → ${loseDest ? `G${Math.abs(loseDest.gameNo)}` : 'eliminated'}`;
      const when = g.time ? laDate(g.time) : 'time TBD';
      const where = g.field ? ` @ ${[g.fac, g.field].filter(Boolean).join(' ')}` : '';
      out.push(`  G${A}${g.gameNo < 0 ? ' (placement)' : ''} [${when}${where}]: ${slotName(a)} vs ${slotName(c)}${score}${winTag} — ${adv}`);
    }
  }

  // Focused: Wicked's next unplayed game + its win/lose outcomes (mirrors dashboard wickedNextPaths).
  // Wicked's earliest game where it's an assigned slot (or already live) and not yet final.
  let pick = null;
  for (const b of framed) {
    const byNoLive = liveByNo(b.level);
    for (const g of b.frame) {
      const lv = byNoLive[Math.abs(g.gameNo)];
      const here = g.topId === myId || g.botId === myId || (lv && (lv.topId === myId || lv.botId === myId));
      if (!here || (lv && isFinal(lv.status))) continue;
      const t = (lv && lv.time) || g.time || '';
      if (!pick || String(t) < String(pick.t)) pick = { b, g, t };
    }
  }
  if (pick) {
    const { b, g } = pick;
    const games = liveOf(b.level);
    const A = Math.abs(g.gameNo);
    const sa = resolveSlot(b, games, g.topSeed, g.topId, g.topName, g.topGame);
    const sc = resolveSlot(b, games, g.botSeed, g.botId, g.botName, g.botGame);
    const oppNow = sa.team?.id === myId ? sc : sa;
    // Estimate the final place for a terminal outcome (no downstream game). Grand final is exact.
    const estimatePlace = (frame, gameNo, isWin) => {
      const M = Math.abs(gameNo);
      if (!frame.some(x => x.topGame === M || x.botGame === M)) return isWin ? '1st place (champion)' : '2nd place';
      const cur = frame.find(x => Math.abs(x.gameNo) === M);
      const nearer = frame.filter(x => x.gameNo < 0 && x.round < (cur?.round ?? 99)).length;
      return `${ordinal(3 + nearer)} place (estimated)`;
    };
    const branch = ref => {
      const dg = b.frame.find(x => x.topGame === ref || x.botGame === ref);
      if (!dg) return { terminal: true, place: estimatePlace(b.frame, A, ref > 0) };
      const wickedIsTop = dg.topGame === ref;
      const opp = wickedIsTop
        ? resolveSlot(b, games, dg.botSeed, dg.botId, dg.botName, dg.botGame)
        : resolveSlot(b, games, dg.topSeed, dg.topId, dg.topName, dg.topGame);
      return { gameNo: Math.abs(dg.gameNo), time: dg.time, opp };
    };
    const fmtOpp = s => s.team ? `${s.team.seed ? `#${s.team.seed} ` : ''}${s.team.name}` : (s.label || 'TBD');
    const oline = (lbl, r) => r.terminal
      ? `  - If ⟦TEAM⟧ ${lbl}: its run ends → ${r.place}`
      : `  - If ⟦TEAM⟧ ${lbl}: advances to G${r.gameNo} vs ${fmtOpp(r.opp)}${r.time ? ` (${laDate(r.time)})` : ''}`;
    out.push('');
    out.push('=== ⟦TEAM_UP⟧ NEXT GAME — WIN/LOSE OUTCOMES (precomputed; read back, do not recompute) ===');
    out.push(`Next game: G${A} in ${b.label} — ⟦TEAM⟧ vs ${fmtOpp(oppNow)}${g.time ? ` (${laDate(g.time)})` : ''}.`);
    out.push(oline('WINS', branch(A)));
    out.push(oline('LOSES', branch(-A)));

    // Full forward run assuming Wicked keeps winning — supports "and what if we win THAT game?"
    // chains without the model tracing the tree itself. Walk the WIN feed (+gameNo) forward until
    // the championship; each opponent is resolved (concrete team, or "Winner of G#" when undecided).
    const chain = [{ gameNo: A, opp: oppNow, time: g.time }];
    let ref = A;
    const seen = new Set([A]);
    while (true) {
      const dg = b.frame.find(x => x.topGame === ref || x.botGame === ref);
      if (!dg) break;                                  // no downstream → this game was the final
      const da = Math.abs(dg.gameNo);
      if (seen.has(da)) break;                         // guard against malformed cycles
      seen.add(da);
      const opp = dg.topGame === ref
        ? resolveSlot(b, games, dg.botSeed, dg.botId, dg.botName, dg.botGame)
        : resolveSlot(b, games, dg.topSeed, dg.topId, dg.topName, dg.topGame);
      chain.push({ gameNo: da, opp, time: dg.time });
      ref = da;                                        // assume Wicked wins this one too
    }
    if (chain.length > 1) {
      out.push('');
      out.push('=== ⟦TEAM_UP⟧ PROJECTED RUN (each step assumes ⟦TEAM⟧ WINS the previous game) ===');
      chain.forEach((h, i) => out.push(
        `  ${i === 0 ? 'Next: ' : 'then win → '}G${h.gameNo} vs ${fmtOpp(h.opp)}${h.time ? ` (${laDate(h.time)})` : ''}`));
      out.push(`  win G${chain[chain.length - 1].gameNo} → 1st place (champion) 🏆`);
    }
  }

  return out.join('\n');
}

// Projected bracket from current standings, so the bot can answer "who will Wicked likely play
// next round?" Mirrors the dashboard: rank teams (wins → runs allowed → runs scored → run diff),
// then either seed each bracket from its `division` (skill level) or, with no division tags, band
// the global ranking by size. Only emitted PRE-assignment (once the real bracket is posted, the
// BRACKET RESULTS section above is authoritative). Returns a context string or null.
export function buildBracketProjection(snap) {
  if (snap.meta?.projectionUnsupported) return null;
  const myId = snap.meta?.providerTeamId || MY_ID;
  const brackets = Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets || {});
  if (!brackets.length) return null;
  // Don't project once the bracket is actually posted.
  const assigned = Object.values(snap.bracketGames || {}).some(g => (g || []).some(x => x.topId || x.botId));
  if (assigned) return null;

  // Teams with records (join the structure roster — which carries skill `level` — to standings).
  const teams = [];
  for (const k of (snap.poolOrder || Object.keys(snap.pools || {}))) {
    const pool = (snap.pools || {})[k]; if (!pool) continue;
    const standings = pool.standings || [];
    for (const t of (pool.teams || [])) {
      const s = standings.find(x => x.teamID === t.id || x._key === t.id) || {};
      const [w = 0, l = 0, tie = 0] = (s.record || '').split('-').map(n => parseInt(n, 10) || 0);
      teams.push({ id: t.id, name: t.name, level: t.level || null, w, l, t: tie, rf: s.PF ?? 0, ra: s.PA ?? 0 });
    }
  }
  if (!teams.length || teams.every(t => t.w + t.l + t.t === 0)) return null;  // no meaningful results yet

  teams.sort((a, b) =>
    (b.w - a.w) || ((a.ra || 0) - (b.ra || 0)) || ((b.rf || 0) - (a.rf || 0)) ||
    (((b.rf || 0) - (b.ra || 0)) - ((a.rf || 0) - (a.ra || 0))));

  const seedOrder = n => { if (n <= 1) return [1]; const p = seedOrder(n / 2); const o = []; for (const s of p) { o.push(s); o.push(n + 1 - s); } return o; };
  const nextPow2 = n => { let c = 1; while (c < n) c *= 2; return Math.max(c, 1); };
  const perDivision = brackets.some(b => b.division);

  const out = ['=== PROJECTED BRACKETS (based on current standings; the tournament sets the real bracket) ==='];
  let start = 0;
  for (const b of brackets) {
    // Which teams seed into this bracket?
    let bt;
    if (perDivision) bt = teams.filter(t => t.level === b.division).slice(0, b.size);
    else { bt = teams.slice(start, start + b.size); start += b.size; }
    const N = bt.length;
    out.push(`-- ${b.label} bracket${b.division ? ` (${b.division} teams)` : ''} --`);
    if (N < 2) { out.push(`  ${N === 1 ? 'Single team — no bracket.' : 'Not enough teams yet.'}`); continue; }
    out.push('  Projected seeding: ' + bt.map((t, i) => `#${i + 1} ${t.name}`).join(', '));

    // Build the single-elimination tree (byes for seeds beyond N); track best (most-likely) seed
    // and whether Wicked is in each slot's subtree.
    // Each slot carries `ml` = its most-likely-occupant short label ("#S Name"); winner slots
    // reference feeders by `ml` so "winner of (…)" never nests more than one level deep.
    const mk = seed => { const t = bt[seed - 1]; const ml = `#${seed} ${t.name}`; return { label: ml, ml, bestSeed: seed, bestName: t.name, hasMe: t.id === myId, kind: 'team' }; };
    let entrants = seedOrder(nextPow2(N)).map(s => s <= N ? mk(s) : null);
    const columns = [];
    while (entrants.length > 1) {
      const next = [], games = [];
      for (let i = 0; i < entrants.length; i += 2) {
        const a = entrants[i], c = entrants[i + 1];
        if (a && !c) { next.push(a); continue; }
        if (!a && c) { next.push(c); continue; }
        if (!a && !c) { next.push(null); continue; }
        games.push({ a, b: c });
        const better = a.bestSeed <= c.bestSeed ? a : c;
        const ml = `#${better.bestSeed} ${better.bestName}`;
        next.push({ label: `winner of (${a.ml} / ${c.ml})`, ml, likely: ml,
                    bestSeed: better.bestSeed, bestName: better.bestName, hasMe: a.hasMe || c.hasMe, kind: 'winner' });
      }
      if (games.length) columns.push(games);
      entrants = next;
    }
    const colLabel = ci => { const e = columns.length - 1 - ci; return e === 0 ? 'Final' : e === 1 ? 'Semifinals' : e === 2 ? 'Quarterfinals' : `Round of ${2 ** (e + 1)}`; };
    const side = s => s.kind === 'winner' ? `${s.label} — most likely ${s.likely}` : s.label;
    columns.forEach((games, ci) => {
      out.push(`  ${colLabel(ci)}:`);
      for (const g of games) out.push(`    • ${side(g.a)} vs ${side(g.b)}`);
    });

    // Wicked's projected path (skip if not in this bracket).
    if (bt.some(t => t.id === myId)) {
      const path = [];
      let byeR1 = !(columns[0] || []).some(g => g.a.hasMe || g.b.hasMe);
      columns.forEach((games, ci) => {
        const g = games.find(g => g.a.hasMe || g.b.hasMe); if (!g) return;
        const opp = g.a.hasMe ? g.b : g.a;
        path.push(`${colLabel(ci)} — vs ${side(opp)}`);
      });
      out.push(`  → ⟦TEAM⟧ projected path${byeR1 ? ' (Round 1 BYE)' : ''}: ${path.join('; ')}`);
    }
  }
  return out.join('\n');
}

// A readable short team name for scenario prose: drop the trailing "- City" coach/city tag
// and the "10B/10C/10U" level token. Ported verbatim from index.html's shortTeam().
function shortTeam(name) {
  const s = (name || '')
    .replace(/\s*-\s*[A-Za-z .'&]+$/, '')
    .replace(/\s*\b10[BCUbcu]\b/, '')
    .replace(/\s{2,}/g, ' ').trim();
  return s || name || '';
}

// The concrete win/tiebreaker paths for Wicked to finish AHEAD of a single rival in the final
// pool seeding. Ported verbatim from index.html's seedBattleLine() (pure math — same bounds the
// dashboard shows). Returns an array of path phrases, or null when the pairwise result is decided.
function seedBattleLine(me, r, remOf) {
  const wNow = me.w || 0, wRem = remOf(me), wMax = wNow + wRem;
  const rNow = r.w || 0, rRem = remOf(r), rMax = rNow + rRem;
  const raW = me.ra || 0, raR = r.ra || 0;
  if (rNow > wMax) return null;
  if (rMax < wNow) return null;
  const R = shortTeam(r.name);
  const num = n => ['zero','one','two','three','four','five','six','seven','eight'][n] ?? String(n);
  const paths = [];

  const kMin = rMax - wMax + 1;
  if (kMin <= 0) {
    paths.push(wRem ? `⟦TEAM⟧ wins out` : `⟦TEAM⟧ is already ahead on wins`);
  } else if (kMin <= rRem) {
    const loseTxt = kMin === rRem
      ? `loses out (${rRem} game${rRem === 1 ? '' : 's'})`
      : `loses ${num(kMin)}${kMin > 1 ? '+' : ''} of its ${rRem} remaining`;
    paths.push((wRem ? `⟦TEAM⟧ wins out and ` : ``) + `${R} ${loseTxt}`);
  }

  const tiePossible = wMax >= rNow && rMax >= wNow;
  if (tiePossible) {
    if (wRem === 0) {
      const allowance = raW - raR;
      if (allowance < 0) {
        paths.push(`they tie on wins — ⟦TEAM⟧ already holds the runs-allowed tiebreaker (${raW} vs ${raR})`);
      } else {
        const span = rRem === 1 ? `its last game` : `its last ${rRem} games`;
        paths.push(`${R} ties ⟦TEAM⟧ on wins but allows more than ${allowance} run${allowance === 1 ? '' : 's'} in ${span} (runs-allowed tiebreaker: ⟦TEAM⟧ ${raW}, ${R} ${raR})`);
      }
    } else {
      paths.push(`they finish tied on wins and ⟦TEAM⟧ ends with fewer runs allowed (now ⟦TEAM⟧ ${raW}, ${R} ${raR})`);
    }
  }

  return paths.length ? paths : null;
}

// Wicked's clinch / elimination outlook, ported from the dashboard's buildWickedScenarios()
// (index.html) so the bot answers bracket-scenario questions from the SAME provably-correct
// win-based bounds instead of doing the combinatorial math itself (which it gets wrong). Mirrors
// buildBrackets' two seeding regimes the way buildBracketProjection does. Returns text, or null.
//   Floor (worst): Wicked loses out AND every team that could match its win total finishes ahead.
//   Ceiling (best): Wicked wins out AND only teams with strictly more wins stay ahead.
// These bounds are sound regardless of run differential, so "clinched"/"eliminated" are always valid.
export function buildWickedScenarioContext(snap) {
  if (snap.meta?.projectionUnsupported) return null;
  const myId = snap.meta?.providerTeamId || MY_ID;
  const brackets = Array.isArray(snap.brackets) ? snap.brackets : Object.values(snap.brackets || {});
  if (!brackets.length) return null;
  // Once the real bracket is posted, BRACKET RESULTS is authoritative — no more pool-seed scenarios.
  const assigned = Object.values(snap.bracketGames || {}).some(g => (g || []).some(x => x.topId || x.botId));
  if (assigned) return null;

  // Roster joined to standings, each tagged with its pool (so we can count remaining games).
  const teams = [];
  const poolGames = {};
  for (const k of (snap.poolOrder || Object.keys(snap.pools || {}))) {
    const pool = (snap.pools || {})[k]; if (!pool) continue;
    poolGames[k] = pool.games || [];
    const standings = pool.standings || [];
    for (const t of (pool.teams || [])) {
      const s = standings.find(x => x.teamID === t.id || x._key === t.id) || {};
      const [w = 0, l = 0, tie = 0] = (s.record || '').split('-').map(n => parseInt(n, 10) || 0);
      teams.push({ id: t.id, name: t.name, level: t.level || null, poolKey: k,
                   w, l, t: tie, rf: s.PF ?? 0, ra: s.PA ?? 0,
                   officialRank: s.officialRank ?? null });
    }
  }
  const me = teams.find(t => t.id === myId);
  if (!me) return null;
  if (teams.every(t => t.w + t.l + t.t === 0)) return null;   // no meaningful results yet

  const totalGames = t => (poolGames[t.poolKey] || []).filter(g => g.hid === t.id || g.aid === t.id).length;
  const remOf = t => Math.max(0, totalGames(t) - ((t.w || 0) + (t.l || 0) + (t.t || 0)));   // ties are played

  // Regime: per-division ranks Wicked among its own level only; else global tiers over all teams.
  const perDivision = brackets.some(b => b.division);
  const myLevel = perDivision ? me.level : null;
  const divBrackets = perDivision ? brackets.filter(b => b.division === myLevel) : [];
  const useDiv = perDivision && !!myLevel && divBrackets.length > 0;
  const ranking = (useDiv ? teams.filter(t => t.level === myLevel) : teams).slice();
  ranking.sort((a, b) =>
    (a.officialRank != null && b.officialRank != null ? a.officialRank - b.officialRank : 0) ||
    (b.w - a.w) || ((a.ra || 0) - (b.ra || 0)) || ((b.rf || 0) - (a.rf || 0)) ||
    (((b.rf || 0) - (b.ra || 0)) - ((a.rf || 0) - (a.ra || 0))));

  // Bands = cumulative size windows over the relevant brackets (last band absorbs the rest).
  const srcBrackets = useDiv ? divBrackets : brackets;
  let acc = 0;
  const bands = srcBrackets.map((b, i) => {
    acc += b.size;
    return { label: b.label, plain: b.label, max: i === srcBrackets.length - 1 ? Infinity : acc };
  });
  const bandOfL = seed => bands.find(b => seed <= b.max) || bands[bands.length - 1];
  const topBand = bands[0], lastBand = bands[bands.length - 1];
  const singleBracket = useDiv && bands.length === 1;
  const nTeams = ranking.length;

  const wWins = me.w || 0, wRem = remOf(me), wMax = wWins + wRem, wMin = wWins;
  const total = totalGames(me), played = total - wRem;
  const curSeed = ranking.findIndex(t => t.id === myId) + 1;
  const anyGamesLeft = ranking.some(t => remOf(t) > 0);

  // Win-only bounds are intentionally conservative while games remain. After pool play ends,
  // the standings' full tiebreak ordering is final, so the range collapses to the actual seed.
  let bestSeed = curSeed, worstSeed = curSeed;
  if (anyGamesLeft) {
    let aheadWorst = 0;   // floor: others win out, ties counted against Wicked
    ranking.forEach(t => { if (t.id === myId) return; if (((t.w || 0) + remOf(t)) >= wMin) aheadWorst++; });
    worstSeed = aheadWorst + 1;
    let aheadBest = 0;    // ceiling: others lose out, only strictly-more-wins locked ahead
    ranking.forEach(t => { if (t.id === myId) return; if ((t.w || 0) > wMax) aheadBest++; });
    bestSeed = aheadBest + 1;
  }

  const curB = bandOfL(curSeed), worstB = bandOfL(worstSeed), bestB = bandOfL(bestSeed);
  const locked = bestB.label === worstB.label;
  const seedRange = bestSeed === worstSeed ? `#${bestSeed}` : `#${bestSeed}-#${worstSeed}`;
  const nextPow2 = n => { let c = 1; while (c < n) c *= 2; return Math.max(c, 1); };

  const out = ['=== ⟦TEAM_UP⟧ CLINCH / ELIMINATION (win-based bounds from current standings) ==='];
  out.push(`Pool play: ${played}/${total} of ⟦TEAM⟧'s pool games complete, ${wRem} remaining.`);
  if (singleBracket) {
    out.push(`Destination locked: ${bands[0].plain} (the 10${myLevel} bracket). Projected ${seedRange} seed among the ${nTeams} 10${myLevel} teams.`);
  } else if (locked) {
    out.push(`Locked into ${worstB.label} — no remaining result can change ⟦TEAM⟧'s bracket.`);
  } else {
    out.push(`Projected bracket: ${curB.label} (currently seeded #${curSeed} of ${nTeams}${useDiv ? ` 10${myLevel}` : ''} teams; can still swing).`);
  }
  out.push(`Best possible seed #${bestSeed} (${singleBracket ? bands[0].plain : bestB.label}); worst possible seed #${worstSeed} (${singleBracket ? bands[0].plain : worstB.label}).`);

  // Clinch / elimination claims (strongest true claim each way) — same logic as the dashboard.
  const joinList = (a, conj) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ` ${conj} ` + a[a.length - 1];
  const lines = [];
  if (singleBracket) {
    const destSize = divBrackets[0].size;
    const rawByes = Math.max(0, nextPow2(destSize) - destSize);
    const byes = Math.min(rawByes, (destSize - rawByes) / 2);
    if (byes === 1) {
      if (worstSeed === 1) lines.push(`Clinched the #1 seed and a first-round bye in ${bands[0].plain}.`);
      else if (bestSeed === 1) lines.push(`Still alive for the #1 seed and a first-round bye${anyGamesLeft ? '' : ' (final)'}.`);
      else lines.push(`Cannot reach the #1 seed — no first-round bye.`);
    } else {
      if (worstSeed === 1) lines.push(`Clinched the #1 seed in ${bands[0].plain}.`);
      else if (bestSeed === 1) lines.push(`Still alive for the #1 seed${anyGamesLeft ? '' : ' (final)'}.`);
      if (byes > 1) {
        if (worstSeed <= byes) lines.push(`Clinched a first-round bye — locked into a top-${byes} seed.`);
        else if (bestSeed > byes) lines.push(`Cannot reach a first-round bye — can't get a top-${byes} seed.`);
        else if (worstSeed !== 1) lines.push(`Still alive for a first-round bye (need a top-${byes} seed).`);
      }
    }
    if (!lines.length) lines.push(`Seeding ${seedRange} in ${bands[0].plain}${anyGamesLeft ? '' : ' (final)'}.`);
  } else {
    if (worstB !== lastBand) {
      if (worstB === topBand) lines.push(`Clinched ${topBand.label} — cannot fall out of the top ${topBand.max}.`);
      else {
        const lower = bands.slice(bands.indexOf(worstB) + 1).map(b => b.plain);
        lines.push(`Clinched ${worstB.label} or better — cannot fall to ${joinList(lower, 'or')}.`);
      }
    }
    if (bestB !== topBand) {
      const higher = bands.slice(0, bands.indexOf(bestB)).map(b => b.plain);
      lines.push(`Eliminated from ${joinList(higher, '&')} — best possible is ${bestB.label}.`);
    }
    if (!lines.length) lines.push(`Still alive for ${bestB.label}${anyGamesLeft ? '' : ' (final)'}.`);
  }
  for (const l of lines) out.push(`- ${l}`);

  // Per-rival "what needs to happen" — only once Wicked has played AND the seed is still unsettled.
  if (played > 0 && bestSeed !== worstSeed) {
    const myIdx = curSeed - 1;
    const order = [];
    for (let d = 1; d < ranking.length; d++) {
      if (myIdx - d >= 0) order.push(myIdx - d);
      if (myIdx + d < ranking.length) order.push(myIdx + d);
    }
    const battle = [];
    for (const idx of order) {
      if (battle.length >= 4) break;
      const r = ranking[idx];
      const paths = seedBattleLine(me, r, remOf);
      if (!paths) continue;
      const verb = idx < myIdx ? 'Pass' : 'Hold off';
      battle.push(`${verb} ${shortTeam(r.name)} (now #${idx + 1}): ${paths.join(' OR ')}.`);
    }
    if (battle.length) {
      out.push('What needs to happen:');
      for (const b of battle) out.push(`- ${b}`);
    }
  }

  // Wicked's remaining/played pool games.
  const myGames = (poolGames[me.poolKey] || []).filter(g => g.hid === myId || g.aid === myId);
  if (myGames.length) {
    out.push("⟦TEAM⟧'s pool games:");
    for (const g of myGames) {
      const opp = g.hid === myId ? g.an : g.hn;
      const res = snap.results?.[g.key] || {};
      // Manual overrides use "won"/"lost"; NorCal uses "completed". Both are final.
      const fin = res.status === 'completed' || res.status === 'won' || res.status === 'lost';
      const status = fin ? 'FINAL' : (res.status && res.status !== 'upcoming' ? 'LIVE' : '');
      let tag = laDate(g.time);
      if (res.topScore != null && res.botScore != null && status) {
        const myScore = g.hid === myId ? res.topScore : res.botScore;
        const opScore = g.hid === myId ? res.botScore : res.topScore;
        const wl = status === 'FINAL' ? (myScore > opScore ? 'W' : myScore < opScore ? 'L' : 'T') : 'LIVE';
        tag = `${wl} ${myScore}-${opScore} [${status}]`;
      }
      out.push(`  • vs ${shortTeam(opp)} — ${tag}`);
    }
  }
  return out.join('\n');
}

const SYSTEM_INSTRUCTIONS = `You are the friendly assistant for the ⟦TEAM⟧ youth softball team's dashboard. Parents and players ask you about schedules, tournament rules, past tournaments, and games ⟦TEAM⟧ played.

Guidelines:
- Answer ONLY from the schedule, season history, results, and rules provided below. If something isn't covered, say you don't have that info and suggest checking the dashboard or with the team manager. Never invent game times, scores, fields, opponents, placements, records, or rules.
- "Us"/"we"/"our team" means ⟦TEAM⟧. Be aware of which games are theirs.
- You MAY answer likely-opponent / seeding / bracket-path questions using the PROJECTED BRACKETS block. Frame it as an estimate based on current standings that can change as remaining pool games are played; the higher seed is the "most likely" team to fill a slot. Prefer actual results (BRACKET RESULTS) over projections when both exist.
- When the BRACKET STRUCTURE block is present, the bracket is already posted (real teams placed) — use it (NOT projections) for "who do we play if we beat/lose to X", "where do we go if we win", and "what's our path" questions. Each game lists its two slots and where the winner and loser advance ("winner → G9, loser → G12"); follow those feeds to name the next opponent. For ⟦TEAM⟧'s immediate next game, the ⟦TEAM_UP⟧ NEXT GAME — WIN/LOSE OUTCOMES block already states both outcomes (next opponent or final place) — read it back verbatim; do not recompute it. For "and what if we win that game too / what if we keep winning / how far can we go" follow-ups, the ⟦TEAM_UP⟧ PROJECTED RUN block lists the whole winners' path step by step — read it back; do not trace the tree yourself. For any OTHER branch (e.g. "what if we LOSE then win the next one", or a non-⟦TEAM⟧ team's path), trace the BRACKET STRUCTURE feeds. A slot like "Winner of G3" means that game hasn't finished yet, so the opponent is still TBD — say so.
- For "what bracket will we make / can we still reach X / are we eliminated / what do we need to win" questions, use the ⟦TEAM_UP⟧ CLINCH / ELIMINATION block. Those bounds and "what needs to happen" paths are already computed and mathematically valid — read them back; DO NOT recompute the seeding/clinch math yourself. State "clinched"/"eliminated" only when that block says so; otherwise present the floor/ceiling range and the relevant paths. If the question is about ⟦TEAM⟧'s bracket outlook and that block is absent, the bracket is either already set (see BRACKET RESULTS) or standings aren't posted yet — say so.
- If the live context says SCHEDULE STATUS: NOT PUBLISHED YET, say the schedule hasn't been posted and share what IS known (dates, location, division, registered teams, rules). Never guess game times, fields, opponents, or pools.
- Use the SEASON TOURNAMENT SCHEDULE for questions about other tournaments this season (what's next, when/where a tournament is).
- All times are Pacific (the tournament's local time). Today's date is given in the live context.
- Be concise and warm. Use short sentences or small bullet lists. This renders on a phone.
- For rules questions, quote the relevant rule briefly. For schedule questions, give the specific day/time/field/opponent.`;

const SEASON_HISTORY_INSTRUCTIONS = `

COMPLETED-SEASON MODE:
- The season is over. There is NO active tournament, no upcoming game, and no live standings. Never call the archived final tournament "current" or "live".
- Use ⟦TEAM_UP⟧ ARCHIVED SEASON HISTORY as the authority for past-tournament, opponent, score, win/loss, record, placement, podium, and season-total questions.
- The FINAL TOURNAMENT ARCHIVE provides extra detail about the last tournament only. Do not generalize its pool standings or bracket to other tournaments.
- If asked when/where/who ⟦TEAM⟧ plays next, warmly say the season is complete and there is no next game scheduled.
- When asked about a particular tournament, list only games whose tournament name matches it. When asked for all games or season totals, use the full archived game log and tournament summary.`;

// Prompt and context templates name our team with the ⟦TEAM⟧ / ⟦TEAM_UP⟧ sentinels, filled in
// here. Only the sentinels are replaced — provider data (pool/roster team names, which can
// themselves contain "Wicked") passes through untouched.
export function personalizeChatText(text, teamName) {
  if (!text) return text;
  const name = teamName || 'Team';
  return text.replaceAll('\u27e6TEAM_UP\u27e7', name.toUpperCase()).replaceAll('\u27e6TEAM\u27e7', name);
}

// --- Handler --------------------------------------------------------------
export default async function handler(req) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'The chat assistant is not configured yet.' }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const question = (body?.question || '').toString().trim();
  if (!question) return json({ error: 'Ask a question first.' }, 400);
  if (question.length > 1000) return json({ error: 'That question is too long.' }, 400);

  const ip = req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (!(await checkRate(ip))) return json({ error: "You're asking a lot quickly — give it a minute and try again." }, 429);

  // Prior turns for natural follow-ups (client sends last few; cap + sanitize).
  const history = Array.isArray(body?.history) ? body.history
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-6)
    .map(t => ({ role: t.role, content: t.content.slice(0, 2000) })) : [];

  try {
    const anthropic = new Anthropic();
    const context = await resolveContext(body.context || {}, { allowEmptyEvent:true });
    const { team, season, event, eventId, scope } = context;
    const [structure, results, overrides, storedArchive] = await Promise.all([
      readStructure(eventId, scope), readResults(eventId, scope), readOverrides(eventId, scope),
      seasonIsComplete(season) ? readScopedArchive(context.teamKey, context.seasonKey) : null,
    ]);
    let archive = storedArchive;
    if (archive && !verifyArchiveBundle(archive)) archive = null;
    if (!archive && seasonIsComplete(season) && season.archiveExport?.path) {
      try {
        const response = await fetch(new URL('/' + season.archiveExport.path.replace(/^\/+/, ''), req.url));
        if (response.ok) {
          const candidate = await response.json();
          if (verifyArchiveBundle(candidate)) archive = candidate;
        }
      } catch {}
    }
    const archivedEvent = archive?.events?.[context.eventKey] || null;
    const archivedSnapshot = archivedEvent?.snapshot || null;
    const servedTeam = archive?.team || team;
    const servedSeason = archive?.season || season;
    const servedEvents = archive?.events || season.events || {};
    let snap = archivedSnapshot || mergeSnapshot(structure, results, overrides);
    const today = new Date().toLocaleDateString('en-CA', { timeZone:'America/Los_Angeles' });
    const seasonSchedule = buildSeasonScheduleContext(season.seasonData, { currentKey:context.eventKey, today });
    if (!snap && !seasonIsComplete(season)) {
      // No active tournament yet (or its setup hasn't run): the season schedule is all there is.
      if (!seasonSchedule) return json({ error: "There's no tournament schedule for this team yet — check back once one is added." }, 503);
      snap = { meta:{ name:'No active tournament', schedulePending:true } };
    }
    if (!snap) return json({ error: "The schedule isn't loaded yet — check back once games are posted." }, 503);
    const servedFinalStats = servedSeason.finalStats || season.finalStats;
    if (seasonIsComplete(season) && servedFinalStats) {
      snap = {
        ...snap,
        wicked:{ ...(snap.wicked || snap.meta?.wicked || {}), ...servedFinalStats, seasonFrozen:true },
      };
    }

    const rulesUrl = archivedEvent?.config?.rulesUrl || event?.config?.rulesUrl || snap.meta?.rulesUrl || null;
    const rulesCacheKey = `${context.teamKey}:${context.seasonKey}:${context.eventKey}`;
    const seasonComplete = seasonIsComplete(season);
    const rulesText = await getRulesText(rulesCacheKey, rulesUrl, anthropic, seasonComplete);
    const historyConfig = {
      seasonData:servedSeason.seasonData || [],
      seasonFinalStats:servedFinalStats || null,
      events:Object.fromEntries(Object.values(servedEvents)
        .filter(e => e.providerRef).map(e => [e.providerRef, e.config || {}])),
    };
    const teamName = servedTeam.shortName || servedTeam.name;

    // Frozen prefix (instructions + rules) is cached; volatile schedule/scores follow.
    const frozen = personalizeChatText(SYSTEM_INSTRUCTIONS + (seasonComplete ? SEASON_HISTORY_INSTRUCTIONS : ''), teamName) +
      '\n\n=== TOURNAMENT RULES ===\n' +
      (rulesText || `(The rules document could not be read. Tell the user you can only help with ${seasonComplete ? 'the completed season history' : 'the schedule'} right now.)`);
    const liveRaw = seasonComplete
      ? `${buildSeasonHistoryContext(snap, historyConfig)}\n\n=== FINAL TOURNAMENT ARCHIVE ===\n${buildScheduleContext(snap, servedTeam)}`
      : `=== LIVE SCHEDULE & STANDINGS ===\nCurrent time (Pacific): ${laDate(new Date().toISOString())}\n\n${
        event ? buildScheduleContext(snap, servedTeam) : `No tournament is currently active for ⟦TEAM⟧.`}${seasonSchedule ? `\n\n${seasonSchedule}` : ''}`;
    const live = personalizeChatText(liveRaw, teamName);

    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: [
        { type: 'text', text: frozen, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: live },
      ],
      messages: [...history, { role: 'user', content: question }],
    });

    const answer = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return json({ answer: answer || "Sorry, I couldn't come up with an answer to that." });
  } catch (e) {
    console.error('chat error', e);
    return json({ error: 'Something went wrong answering that. Please try again.' }, 500);
  }
}

export const config = { path: '/api/chat' };
