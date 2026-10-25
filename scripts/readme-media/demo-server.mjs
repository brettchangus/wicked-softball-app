// Local demo server for the README media: the real index.html and assets, with every API answered
// from the fictional data in demo-data.mjs. Nothing contacts Netlify, Blob storage or a provider.
//
//   node scripts/readme-media/demo-server.mjs            → http://localhost:3077 (Saturday scenario)
//   GET /__demo/scenario?name=sunday                     → switch scenarios without restarting
//
// capture.mjs starts this itself; run it directly to click around the demo in a browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemo, catalog, chatAnswer, highScores, weather, CONTEXT_PATH } from './demo-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.wav':'audio/wav',
  '.woff':'font/woff', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
// Only the public site files; never the functions, tests, scripts or data fixtures with real names.
const SERVED = /^\/(index\.html|manifest\.json|sw\.js|assets\/[\w.-]+)$/;

export function startDemoServer({ port = 3077, scenario = 'saturday', snapshotDelayMs = 0 } = {}) {
  const demo = buildDemo();
  const state = { scenario, snapshotDelayMs };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/__demo/scenario') {
        if (url.searchParams.get('name')) state.scenario = url.searchParams.get('name');
        if (url.searchParams.has('delay')) state.snapshotDelayMs = Number(url.searchParams.get('delay')) || 0;
        return json(res, state);
      }
      if (p === '/api/snapshot') {
        if (state.snapshotDelayMs) await new Promise(r => setTimeout(r, state.snapshotDelayMs));
        return json(res, url.searchParams.get('eventKey') === 'autumn-slam' ? demo.history : demo.snapshots[state.scenario]);
      }
      if (p === '/api/catalog') return json(res, catalog());
      if (p === '/api/scouting-report') {
        const report = demo.reports[url.searchParams.get('opponent')];
        // A short wait shows the report's own loading skeleton, as on the live site.
        await new Promise(r => setTimeout(r, 650));
        return report ? json(res, { report }) : json(res, { error:'No scouting report for this team yet.' }, 404);
      }
      if (p === '/api/chat') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const question = JSON.parse(body || '{}').question || '';
        await new Promise(r => setTimeout(r, 1400));
        return json(res, { answer:chatAnswer(question, state.scenario) });
      }
      if (p === '/api/highscores') return json(res, req.method === 'POST' ? { ok:true, board:highScores().board } : highScores());
      if (p === '/__demo/weather') return json(res, weather());
      if (p === '/push-tests-enabled') return json(res, { enabled:false });
      if (p === '/subscribe') return json(res, { ok:true });
      if (p === '/' ) { res.writeHead(302, { Location:CONTEXT_PATH }); return res.end(); }
      // The stand-in logo replaces the team's real one everywhere the page loads it.
      if (p === '/assets/icon.png' || p === '/assets/apple-touch-icon.png') {
        res.writeHead(200, { 'Content-Type':'image/svg+xml', 'Cache-Control':'no-store' });
        return fs.createReadStream(path.join(HERE, 'demo-logo.svg')).pipe(res);
      }
      const file = p.startsWith('/teams/') || p === '/play' ? '/index.html' : p;
      if (!SERVED.test(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type':TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
      fs.createReadStream(path.join(ROOT, file)).pipe(res);
    } catch (error) {
      json(res, { error:error.message }, 500);
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, state, url:`http://localhost:${port}` })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startDemoServer({ port:Number(process.env.PORT || 3077) });
  console.log(`Demo dashboard: ${url}${CONTEXT_PATH}`);
}
