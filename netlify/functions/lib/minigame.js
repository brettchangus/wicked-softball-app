// Homerun Derby mini-game data, scoped per team + season (docs: AGENTS.md "Home Run Derby").
// The roster lives on the season record (`season.miniGame.roster`, `tournament` Blob store); the
// high-score board lives in the `minigame-highscores` store under `boardKey(team, season)`.
import { DEFAULT_TEAM_KEY, DEFAULT_SEASON_KEY } from './tournament.js';

export const MINI_GAME_TONES = ['light', 'tan', 'brown'];
export const MINI_GAME_HAIRS = ['brown', 'blond', 'black', 'red'];
export const ROSTER_MAX = 30;
export const PLAYER_NAME_MAX = 20;

export const isDefaultMiniGameContext = (teamKey, seasonKey) =>
  teamKey === DEFAULT_TEAM_KEY && seasonKey === DEFAULT_SEASON_KEY;

// Cleans an admin-submitted roster. Blank names are dropped; a duplicate name (case-insensitive)
// is an error rather than a silent drop, since the game identifies players by name.
export function normalizeRoster(input) {
  if (!Array.isArray(input)) throw new Error('roster must be a list of players');
  const seen = new Set();
  const roster = [];
  for (const raw of input) {
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, PLAYER_NAME_MAX);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`"${name}" is on the roster more than once`);
    seen.add(key);
    const n = raw?.number === '' || raw?.number == null ? null : Number(raw.number);
    roster.push({
      name,
      number: Number.isInteger(n) && n >= 0 && n <= 99 ? n : null,
      tone: MINI_GAME_TONES.includes(raw?.tone) ? raw.tone : 'light',
      hair: MINI_GAME_HAIRS.includes(raw?.hair) ? raw.hair : 'brown',
      batsL: raw?.batsL === true,
      fieldsL: raw?.fieldsL === true,
    });
  }
  if (roster.length > ROSTER_MAX) throw new Error(`a roster can have at most ${ROSTER_MAX} players`);
  return roster;
}

// The roster the game should use. Both a missing roster and a saved empty list hide the game;
// player data is deliberately never supplied by a source-controlled fallback.
export function effectiveRoster({ teamKey, seasonKey, season } = {}) {
  if (Array.isArray(season?.miniGame?.roster)) return season.miniGame.roster;
  return [];
}

export const boardKey = (teamKey, seasonKey) => `board:${teamKey}:${seasonKey}`;
export const boardCacheKey = (teamKey, seasonKey) => `cache:${teamKey}:${seasonKey}`;
export const LEGACY_BOARD_KEY = 'board';

// Scores are append-only, one Blob per play. Keeping the team + season in the prefix makes
// completed seasons remain independently playable without concurrent submissions replacing a
// shared leaderboard array. `boardKey` remains the optional legacy/base board during migration.
export const scorePrefix = (teamKey, seasonKey) => `score:${teamKey}:${seasonKey}:`;
export const scoreKey = (teamKey, seasonKey, id) => `${scorePrefix(teamKey, seasonKey)}${id}`;
