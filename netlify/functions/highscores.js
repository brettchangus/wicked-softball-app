// GET/POST /api/highscores?team=&season= — the Homerun Derby leaderboard, one board per team +
// season. New entries use collision-safe individual records in `minigame-highscores`; compaction
// retains the best 500 and a fingerprinted cache avoids reading all of them on every request. The
// older shared board arrays remain read-compatible migration inputs. Both context keys are required.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { contextInputFromRequest, resolveContext, strongReadsAvailable } from './lib/snapshot.js';
import {
  boardCacheKey, boardKey, isDefaultMiniGameContext, LEGACY_BOARD_KEY, scoreKey, scorePrefix,
} from './lib/minigame.js';

const MAX_BOARD = 500;
const NAME_MAX = 20;
const BATTER_MAX = 40;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const ranked = board => [...new Map(board.filter(Boolean).map(entry => [entry.id, entry])).values()]
  .sort((a, b) => b.homeRuns - a.homeRuns)
  .slice(0, MAX_BOARD);

const fingerprint = (base, blobs) => createHash('sha256').update(JSON.stringify({
  base,
  blobs:blobs.map(blob => [blob.key, blob.etag || '']).sort((a, b) => a[0].localeCompare(b[0])),
})).digest('hex');

// The old implementation stored one array per board. Keep reading that array as a migration
// base, but append every new result under its own key so simultaneous players cannot overwrite
// one another. An explicit empty scoped array is also the reset marker that suppresses the
// original global board for the migrated default season.
async function readBoard(store, teamKey, seasonKey, submittedEntry = null) {
  const prefix = scorePrefix(teamKey, seasonKey);
  const [scopedBoard, listing, cached] = await Promise.all([
    store.get(boardKey(teamKey, seasonKey), { type:'json' }),
    store.list({ prefix }),
    store.get(boardCacheKey(teamKey, seasonKey), { type:'json' }),
  ]);
  let base = scopedBoard;
  if (!Array.isArray(base) && isDefaultMiniGameContext(teamKey, seasonKey)) {
    const legacy = await store.get(LEGACY_BOARD_KEY, { type: 'json' });
    if (Array.isArray(legacy)) base = legacy;
  }
  if (!Array.isArray(base)) base = [];
  const blobs = listing.blobs || [];
  const currentFingerprint = fingerprint(base, blobs);
  if (!submittedEntry && cached?.fingerprint === currentFingerprint && Array.isArray(cached.board)) {
    return cached.board;
  }

  let board;
  if (submittedEntry && Array.isArray(cached?.board)) {
    const submittedKey = scoreKey(teamKey, seasonKey, submittedEntry.id);
    const priorFingerprint = fingerprint(base, blobs.filter(blob => blob.key !== submittedKey));
    if (cached.fingerprint === priorFingerprint) board = ranked([...cached.board, submittedEntry]);
  }
  if (!board) {
    const entries = await Promise.all(blobs.map(blob => store.get(blob.key, { type:'json' })));
    board = ranked([...base, ...entries, ...(submittedEntry ? [submittedEntry] : [])]);
  }

  // Keep the collision-safe event records bounded too. Blob ids are the score ids, so pruning
  // never rewrites another submission and a concurrent unseen submission cannot be deleted.
  const keepIds = new Set(board.map(entry => String(entry.id)));
  const compacted = blobs.filter(blob => keepIds.has(blob.key.slice(prefix.length)));
  const discarded = blobs.filter(blob => !keepIds.has(blob.key.slice(prefix.length)));
  await Promise.all(discarded.map(blob => store.delete(blob.key)));
  await store.setJSON(boardCacheKey(teamKey, seasonKey), {
    fingerprint:fingerprint(base, compacted), board,
  });
  return board;
}

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  if (!url.searchParams.get('team') || !url.searchParams.get('season'))
    return json({ error: 'team and season are required' }, 400);

  // Only real team/season pairs get a board, so arbitrary keys can't create storage.
  let context;
  try {
    context = await resolveContext(contextInputFromRequest(req), { allowEmptyEvent: true });
  } catch (e) {
    return json({ error: e.message }, 404);
  }
  const { teamKey, seasonKey } = context;
  // Strong reads make a just-submitted score visible on the next leaderboard request. The runtime
  // may lack the uncached edge URL (local tests/dev), so fall back gracefully.
  const store = strongReadsAvailable()
    ? getStore({ name:'minigame-highscores', consistency:'strong' })
    : getStore('minigame-highscores');

  if (req.method === 'GET') {
    try {
      return json({ board: await readBoard(store, teamKey, seasonKey) });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  try {
    const body = await req.json();
    const homeRuns = Number(body.homeRuns);
    if (!Number.isFinite(homeRuns)) return json({ error: 'homeRuns must be a number' }, 400);
    const hr = Math.max(0, Math.floor(homeRuns));
    const name = String(body.name ?? '').trim().slice(0, NAME_MAX) || 'Player';
    const batter = String(body.batter ?? '').trim().slice(0, BATTER_MAX);
    const id = Date.now() + '_' + Math.random().toString(36).slice(2);
    const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });

    const entry = { id, name, batter, homeRuns: hr, date };
    await store.setJSON(scoreKey(teamKey, seasonKey, id), entry);
    const board = await readBoard(store, teamKey, seasonKey, entry);
    const idx = board.findIndex(e => e.id === id);
    const rank = idx >= 0 ? idx + 1 : -1;
    return json({ id, rank, total: board.length, board });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export const config = { path: '/api/highscores' };
