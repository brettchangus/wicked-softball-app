// Team / season / event model. Provider references are external locators; `key` values are
// stable application identifiers used in URLs and storage. Keep this module free of Blob
// access so its normalization and migration helpers remain straightforward to test.
import {
  AGE_PREFIX, DEFAULT_EVENT_KEY, DEFAULT_SEASON_KEY, DEFAULT_TEAM_KEY,
  MY_ID, PUBLIC_EVENT_ID, SEASON_NAME, SISTER_ID, TEAM_NAME,
} from './tournament.js';

export const MODEL_VERSION = 2;
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// `archived` is the v2 spelling retained for existing stored seasons and archive bundles.
// New writes use `completed`: completion freezes tournament data, but the season remains a
// first-class URL context and its mini-game roster/leaderboard stay available.
export const seasonIsComplete = seasonOrStatus =>
  ['completed', 'archived'].includes(typeof seasonOrStatus === 'string'
    ? seasonOrStatus : seasonOrStatus?.status);
export const canonicalSeasonStatus = status => status === 'archived' ? 'completed' : status;

export function normalizeKey(value, label = 'key') {
  const key = String(value || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) throw new Error(`${label} must use lowercase letters, numbers, and hyphens`);
  return key;
}

// Merges an event's last detection with any admin correction on top — see
// docs/tournament-setup-plan.md. `event.discovery.detected` is what detectEvent last found;
// `event.discovery.manual` is whatever fields an admin overrode in the review form. An event with
// no `discovery` block (every event created before this existed) resolves to an empty selection,
// so buildProviderStructure falls back to its existing agePrefix-based behavior unchanged.
export function effectiveSelection(event) {
  const d = event?.discovery || {};
  return { ...(d.detected || {}), ...(d.manual || {}) };
}

// A short, stable fingerprint of the fields that change what buildProviderStructure fetches
// (not cosmetic fields like name/venue). structureIsCurrent compares this so saving a division/
// team correction forces a rebuild instead of serving the previously discovered structure.
export function selectionHash(selection) {
  const s = selection || {};
  const norm = arr => Array.isArray(arr) ? [...arr].map(String).sort() : [];
  const key = JSON.stringify({
    divisionIds: norm(s.divisionIds),
    sisterDivisionIds: norm(s.sisterDivisionIds),
    providerTeamId: s.providerTeamId != null ? String(s.providerTeamId) : null,
    region: s.region || null,
    teamName: s.teamName || null,
  });
  let hash = 0;
  for (let i = 0; i < key.length; i++) { hash = (hash * 31 + key.charCodeAt(i)) | 0; }
  return hash.toString(36);
}

export function keyFromName(value, fallback = 'item') {
  const key = String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return key || fallback;
}

// Shared by archive.js (strict — throws on invalid placements) and functions/snapshot.js
// (lenient — best-effort display formatting). Each site owns its own validation; this is
// just the "1st/2nd/3rd/4th" suffix rule, factored out so it can't drift between the two.
export function ordinalSuffix(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return { 1:'st', 2:'nd', 3:'rd' }[n % 10] || 'th';
}

export function providerRefFromUrl(url) {
  const value = String(url || '');
  if (/^https:\/\/(?:www\.)?allstartournaments\.com\/fastpitch\/[a-z0-9-]+\//i.test(value)) return value;
  const nc = value.match(/\/event\/(\d+)/)?.[1];
  if (nc) return nc;
  const tournament = value.match(/[?&]IDTournament=([^&]+)/i)?.[1];
  const division = value.match(/[?&]IDDivision=([^&]+)/i)?.[1];
  return tournament && division
    ? `tm:${decodeURIComponent(tournament)}:${decodeURIComponent(division)}`
    : null;
}

export const DEFAULT_SEASON_DATA = [];

function uniqueEventKey(row, used) {
  const explicit = row?.key && KEY_RE.test(String(row.key)) ? String(row.key) : null;
  const base = explicit || keyFromName(row?.name, 'event');
  let key = base, suffix = 2;
  while (used.has(key)) key = `${base}-${suffix++}`;
  used.add(key);
  return key;
}

export function eventsFromSeasonData(seasonData = DEFAULT_SEASON_DATA, legacyEvents = {}, activeEventId = PUBLIC_EVENT_ID) {
  const used = new Set();
  const events = {};
  for (const row of seasonData || []) {
    const providerRef = row.providerRef || providerRefFromUrl(row.url);
    const key = uniqueEventKey(row, used);
    const legacy = providerRef ? legacyEvents?.[providerRef] || {} : {};
    events[key] = {
      key,
      name: row.name || key,
      providerRef,
      providerTeamId: row.providerTeamId || legacy.providerTeamId || null,
      status: row.status === 'done' ? 'completed' : row.status === 'now' ? 'active' : 'upcoming',
      sourceUrl: row.url || null,
      snapshotPath: row.snapshotPath || DEFAULT_SEASON_DATA.find(d => providerRefFromUrl(d.url) === providerRef)?.snapshotPath || null,
      config: { ...legacy },
    };
  }
  // Only synthesize a placeholder when there's an actual active event id unrepresented by a
  // season-data row. When activeEventId is null (e.g. a season with no featured event yet),
  // synthesizing a providerRef:null placeholder would let it get picked up as "featured" and
  // brick every event-scoped admin/API call downstream — so skip it entirely.
  if (activeEventId && !Object.values(events).some(e => e.providerRef === activeEventId)) {
    events[DEFAULT_EVENT_KEY] = {
      key: DEFAULT_EVENT_KEY, name:'Current Tournament', providerRef:activeEventId,
      providerTeamId: legacyEvents?.[activeEventId]?.providerTeamId || null,
      status:'active', sourceUrl:null, snapshotPath:null,
      config:{ ...(legacyEvents?.[activeEventId] || {}) },
    };
  }
  return events;
}

export function canonicalSeasonData(seasonData, events) {
  return (seasonData || []).map(row => {
    const providerRef = row.providerRef || providerRefFromUrl(row.url);
    const event = Object.values(events || {}).find(candidate =>
      (row.key && candidate.key === row.key)
      || (providerRef && candidate.providerRef === providerRef));
    return event ? {
      ...row,
      key:event.key,
      providerRef:event.providerRef,
      snapshotPath:event.snapshotPath || row.snapshotPath || null,
    } : { ...row };
  });
}

export function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function formatCalendarDates(startDate, endDate) {
  if (!validCalendarDate(startDate) || !validCalendarDate(endDate) || startDate > endDate)
    throw new Error('invalid calendar date range');
  const start = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');
  const month = date => date.toLocaleDateString('en-US', { month:'short', timeZone:'UTC' });
  const first = `${month(start)} ${start.getUTCDate()}`;
  if (startDate === endDate) return first;
  return `${first}${start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()
    ? '–' : ' – ' + month(end) + ' '}${end.getUTCDate()}`;
}

// Pre-calendar-date rows stay readable. Only parse recognizable ranges; unfamiliar editorial
// text remains untouched until an admin supplies explicit start/end dates.
export function legacyCalendarDates(text, seasonKey = '') {
  const year = Number(String(seasonKey).match(/(?:19|20)\d{2}/)?.[0]);
  if (!year) return null;
  const match = String(text || '').trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*[–-]\s*(?:([A-Za-z]{3,9})\s+)?(\d{1,2}))?(?:,?\s+\d{4})?$/);
  if (!match) return null;
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const firstMonth = months[match[1].slice(0, 3).toLowerCase()];
  const lastMonth = months[(match[3] || match[1]).slice(0, 3).toLowerCase()];
  if (!firstMonth || !lastMonth) return null;
  const iso = (month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const startDate = iso(firstMonth, Number(match[2]));
  const endDate = iso(lastMonth, Number(match[4] || match[2]));
  return validCalendarDate(startDate) && validCalendarDate(endDate) && startDate <= endDate
    ? { startDate, endDate } : null;
}

export function buildDefaultModel(config = {}, activeEventId = PUBLIC_EVENT_ID) {
  const seasonData = Array.isArray(config.seasonData) && config.seasonData.length
    ? config.seasonData.map(row => ({ ...row }))
    : DEFAULT_SEASON_DATA.map(row => ({ ...row }));
  const events = eventsFromSeasonData(seasonData, config.events || {}, activeEventId);
  const featured = Object.values(events).find(e => e.providerRef === activeEventId)
    || events[DEFAULT_EVENT_KEY] || Object.values(events)[0];
  const completed = config.seasonOver === true;
  const season = {
    schemaVersion: MODEL_VERSION,
    teamKey: DEFAULT_TEAM_KEY,
    key: DEFAULT_SEASON_KEY,
    name: SEASON_NAME,
    status: completed ? 'completed' : 'active',
    featuredEventKey: featured?.key || null,
    seasonData:canonicalSeasonData(seasonData, events),
    finalStats: config.seasonFinalStats || null,
    archiveVersion: completed ? 1 : null,
    archiveExport:null,
    teamConfig: {
      snacksUrl: config.snacksUrl ?? null,
    },
    events,
  };
  const team = {
    schemaVersion: MODEL_VERSION,
    key: DEFAULT_TEAM_KEY,
    name: TEAM_NAME,
    shortName: TEAM_NAME,
    subtitle:null,
    defaultSeasonKey: DEFAULT_SEASON_KEY,
    norcalTeamId: MY_ID,
    sisterTeamId: SISTER_ID,
    agePrefix: AGE_PREFIX,
    logoUrl: 'assets/icon.png',
  };
  const catalog = {
    schemaVersion: MODEL_VERSION,
    defaultTeamKey: DEFAULT_TEAM_KEY,
    teams: {
      [DEFAULT_TEAM_KEY]: {
        key: DEFAULT_TEAM_KEY,
        name: TEAM_NAME,
        defaultSeasonKey: DEFAULT_SEASON_KEY,
        seasons: {
          [DEFAULT_SEASON_KEY]: {
            key: DEFAULT_SEASON_KEY,
            name: SEASON_NAME,
            status: season.status,
          },
        },
      },
    },
  };
  return { catalog, team, season };
}

export function publicCatalog(catalog) {
  return {
    schemaVersion: catalog.schemaVersion || MODEL_VERSION,
    defaultTeamKey: catalog.defaultTeamKey,
    teams: Object.fromEntries(Object.entries(catalog.teams || {}).map(([key, team]) => [key, {
      key: team.key || key,
      name: team.name || key,
      defaultSeasonKey: team.defaultSeasonKey || Object.keys(team.seasons || {})[0] || null,
      seasons: Object.fromEntries(Object.entries(team.seasons || {}).map(([seasonKey, season]) =>
        [seasonKey, { ...season, status:canonicalSeasonStatus(season.status) }])),
    }])),
  };
}
