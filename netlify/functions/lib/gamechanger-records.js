import { readGameChangerRecords, writeGameChangerRecords } from './snapshot.js';

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
  return { record:parseGameChangerRecord(profile, id), location:parseGameChangerLocation(profile, id) };
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

export function locationsForGameChangerLinks(links, saved) {
  return profileFieldForGameChangerLinks(links, saved, 'location');
}

// Fetch only for an explicit admin action. Keep the last good record when a request fails.
export async function refreshGameChangerRecords(scope, links, { teamIds = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const saved = await readGameChangerRecords(scope);
  const validLinks = Object.fromEntries(Object.entries(links || {}).filter(([, url]) => gameChangerPublicId(url)));
  const records = Object.fromEntries(Object.entries(saved).filter(([teamId, row]) =>
    validLinks[teamId] && row?.url === validLinks[teamId]));
  const selected = teamIds == null ? Object.entries(validLinks)
    : Object.entries(validLinks).filter(([teamId]) => teamIds.includes(teamId));
  const updates = await Promise.all(selected.map(async ([teamId, url]) => {
    let profile = null;
    try { profile = await fetchGameChangerProfile(url, fetchImpl); } catch {}
    return [teamId, { url, checkedAt:new Date(now).toISOString(),
      record:profile?.record || records[teamId]?.record || null,
      location:profile?.location || records[teamId]?.location || null,
      failed:!profile?.record }];
  }));
  updates.forEach(([teamId, row]) => { records[teamId] = row; });
  if (updates.length || Object.keys(saved).length !== Object.keys(records).length)
    await writeGameChangerRecords(scope, records);
  return { records:recordsForGameChangerLinks(validLinks, records),
    updated:updates.filter(([, row]) => !row.failed).length,
    failed:updates.filter(([, row]) => row.failed).length };
}
