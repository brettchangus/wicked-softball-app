import { readGameChangerRecords, writeGameChangerRecords } from './snapshot.js';
import { loadDirectoryMatches } from './team-directory.js';

const TOURNAMENT_REFRESH_MS = 30 * 60 * 1000;
const REFRESH_MS = 3 * 60 * 60 * 1000;
// The cron ticks every 5 minutes and may start a little late; don't let a few seconds of
// jitter push a refresh to the next tick.
const CRON_GRACE_MS = 60 * 1000;

// Every GameChanger profile a tournament's records are kept for: its linked opponents plus our
// own team's season link.
export async function linkedGameChangerRecordUrls(context, structure) {
  const links = (await loadDirectoryMatches(context, structure)).links;
  const ownId = structure?.meta?.providerTeamId;
  const ownUrl = context.season?.teamConfig?.gameChangerUrl;
  if (ownId && ownUrl) links[ownId] = ownUrl;
  return links;
}

export function gameChangerPublicId(url) {
  return /^https:\/\/web\.gc\.com\/teams\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i.exec(String(url || ''))?.[1] || null;
}

export function parseGameChangerRecord(profile, expectedId) {
  if (String(profile?.id || '') !== expectedId) return null;
  const record = profile?.team_season?.record;
  if (!record || !['win', 'loss'].every(key =>
    Number.isSafeInteger(record[key]) && record[key] >= 0)) return null;
  const tie = record.tie ?? 0;
  if (!Number.isSafeInteger(tie) || tie < 0) return null;
  return { win:record.win, loss:record.loss, tie };
}

export function parseGameChangerLocation(profile, expectedId) {
  if (String(profile?.id || '') !== expectedId) return null;
  const city = String(profile.location?.city || '').trim().slice(0, 100);
  const rawState = String(profile.location?.state || '').trim().slice(0, 100);
  const state = /^california$/i.test(rawState) ? 'CA' : rawState;
  return city || state ? { city, state } : null;
}

export async function fetchGameChangerProfile(url, fetchImpl = fetch) {
  const id = gameChangerPublicId(url);
  if (!id) return null;
  const response = await fetchImpl(`https://api.team-manager.gc.com/public/teams/${encodeURIComponent(id)}`, {
    headers:{ Accept:'application/json', 'gc-app-name':'web' },
    signal:AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const profile = await response.json();
  if (String(profile?.id || '') !== id) return null;
  return { name:typeof profile.name === 'string' ? profile.name.trim().slice(0, 120) : '',
    record:parseGameChangerRecord(profile, id), location:parseGameChangerLocation(profile, id) };
}

function profileFieldForGameChangerLinks(links, saved, field) {
  const byUrl = new Map(Object.values(saved || {}).filter(row => row?.url && row[field])
    .map(row => [row.url, row[field]]));
  return Object.fromEntries(Object.entries(links || {}).flatMap(([teamId, url]) => {
    const value = (saved?.[teamId]?.url === url && saved[teamId][field]) || byUrl.get(url);
    return value ? [[teamId, value]] : [];
  }));
}

export function recordsForGameChangerLinks(links, saved) {
  return profileFieldForGameChangerLinks(links, saved, 'record');
}

export function namesForGameChangerLinks(links, saved) {
  return profileFieldForGameChangerLinks(links, saved, 'name');
}

export function locationsForGameChangerLinks(links, saved) {
  return profileFieldForGameChangerLinks(links, saved, 'location');
}

// The score cron refreshes records itself (the public profile endpoint needs no token): every
// 30 minutes from the tournament's first day through its last (Pacific), every 3 hours otherwise.
// Due when any linked profile was never checked, was relinked, or was last checked longer ago.
export function gameChangerRecordsRefreshDue(saved, links, { dates = [], todayPT, now = Date.now() } = {}) {
  const linked = Object.entries(links || {}).filter(([, url]) => gameChangerPublicId(url));
  if (!linked.length) return false;
  const days = dates.filter(Boolean).sort();
  const inTournament = days.length > 0 && todayPT >= days[0] && todayPT <= days.at(-1);
  const interval = (inTournament ? TOURNAMENT_REFRESH_MS : REFRESH_MS) - CRON_GRACE_MS;
  return linked.some(([teamId, url]) => saved?.[teamId]?.url !== url
    || !(now - Date.parse(saved[teamId].checkedAt) < interval));
}

// Fetched on a schedule by the score cron and on demand by admin actions. Keep the last good
// record when a request fails.
// A profile's city/state is captured when its link is set (`updateLocation`); a plain record
// refresh keeps the saved location and only fills one in when none was captured yet.
export async function refreshGameChangerRecords(scope, links, { teamIds = null, updateLocation = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const saved = await readGameChangerRecords(scope);
  const validLinks = Object.fromEntries(Object.entries(links || {}).filter(([, url]) => gameChangerPublicId(url)));
  const records = Object.fromEntries(Object.entries(saved).filter(([teamId, row]) =>
    validLinks[teamId] && row?.url === validLinks[teamId]));
  const selected = teamIds == null ? Object.entries(validLinks)
    : Object.entries(validLinks).filter(([teamId]) => teamIds.includes(teamId));
  const updates = await Promise.all(selected.map(async ([teamId, url]) => {
    let profile = null;
    try { profile = await fetchGameChangerProfile(url, fetchImpl); } catch {}
    const previous = records[teamId]?.record;
    return [teamId, { url, checkedAt:new Date(now).toISOString(),
      name:profile?.name || records[teamId]?.name || null,
      record:profile?.record || records[teamId]?.record || null,
      location:(updateLocation ? profile?.location || records[teamId]?.location
        : records[teamId]?.location || profile?.location) || null,
      failed:!profile?.record,
      changed:!!profile?.record && (previous?.win !== profile.record.win
        || previous?.loss !== profile.record.loss || previous?.tie !== profile.record.tie) }];
  }));
  updates.forEach(([teamId, row]) => { records[teamId] = row; });
  if (updates.length || Object.keys(saved).length !== Object.keys(records).length)
    await writeGameChangerRecords(scope, records);
  return { records:recordsForGameChangerLinks(validLinks, records),
    checked:updates.filter(([, row]) => !row.failed).length,
    changed:updates.filter(([, row]) => row.changed).length,
    updated:updates.filter(([, row]) => !row.failed).length,
    failed:updates.filter(([, row]) => row.failed).length };
}
