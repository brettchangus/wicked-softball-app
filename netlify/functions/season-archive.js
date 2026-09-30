import {
  ensureScopedModel, readScopedArchive, readSeason,
} from './lib/snapshot.js';
import { normalizeKey } from './lib/context.js';
import { verifyArchiveBundle } from './lib/archive.js';

export default async function handler(req) {
  const catalog = await ensureScopedModel();
  const url = new URL(req.url);
  try {
    const team = normalizeKey(url.searchParams.get('team') || catalog.defaultTeamKey, 'team key');
    const teamSummary = catalog.teams?.[team];
    if (!teamSummary) return json({ error:`unknown team: ${team}` }, 404);
    const seasonKey = normalizeKey(
      url.searchParams.get('season') || teamSummary.defaultSeasonKey, 'season key');
    const season = await readSeason(team, seasonKey);
    if (!season) return json({ error:`unknown season: ${seasonKey}` }, 404);
    const versionRaw = url.searchParams.get('version');
    const version = versionRaw ? Number(versionRaw) : null;
    let archive = await readScopedArchive(team, seasonKey, version);
    if (!archive && !version && season.archiveExport?.path) {
      try {
        const response = await fetch(new URL('/' + season.archiveExport.path.replace(/^\/+/, ''), req.url));
        if (response.ok) archive = await response.json();
      } catch {}
    }
    if (!archive) return json({ error:'archive not found' }, 404);
    if (!verifyArchiveBundle(archive)) return json({ error:'archive checksum failed' }, 500);
    return json(archive);
  } catch (error) {
    return json({ error:error.message }, 400);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers:{ 'Content-Type':'application/json', 'Cache-Control':'public, max-age=300', 'Access-Control-Allow-Origin':'*' },
  });
}

export const config = { path:'/api/season-archive' };
