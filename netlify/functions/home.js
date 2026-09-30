import { readCatalog } from './lib/snapshot.js';

const COMING_SOON_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#C41230">
  <title>Tournament Hub — Coming soon</title>
  <style>
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 30%,#390814,#08080b 65%);color:#fff;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}
    main{max-width:440px}span{color:#ff667f;font-size:12px;font-weight:800;letter-spacing:.22em;text-transform:uppercase}h1{margin:12px 0;font-size:clamp(2rem,8vw,3rem)}p{margin:0;color:#c5bdc0}
  </style>
</head>
<body><main><span>Tournament Hub</span><h1>Coming soon</h1><p>No team or season is published yet. Check back soon.</p></main></body>
</html>`;

function comingSoon() {
  return new Response(COMING_SOON_HTML, {
    headers:{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' },
  });
}

// Resolve the home URL before sending any dashboard HTML, CSS, or assets.
// An installed iPhone app starts at /, so this avoids loading the dashboard twice.
export default async function handler(request) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const catalog = await readCatalog().catch(() => null);
  const teamKey = (params.get('team') || catalog?.defaultTeamKey || '').toLowerCase();
  const team = catalog?.teams?.[teamKey];
  const seasonKey = (params.get('season') || team?.defaultSeasonKey || Object.keys(team?.seasons || {})[0] || '').toLowerCase();
  if (!team?.seasons?.[seasonKey]) return comingSoon();

  params.delete('team');
  params.delete('season');
  const query = params.toString();
  const destination = `/teams/${encodeURIComponent(teamKey)}/seasons/${encodeURIComponent(seasonKey)}${query ? `?${query}` : ''}`;
  return new Response(null, {
    status:302,
    headers:{ Location:destination, 'Cache-Control':'no-store' },
  });
}

export const config = { path:'/' };
