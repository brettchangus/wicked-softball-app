// Local preview WITH the Netlify functions: `node scripts/dev-server.mjs` → http://localhost:3001
//
// `npx serve` only serves static files, so /admin can't unlock and /api/snapshot 404s. This runs
// the real function handlers (netlify/functions/*.js, routed by each file's `config.path`) against
// an IN-MEMORY Blob store, so the admin page and the dashboard work end to end on this machine.
// Nothing is written to the deployed site: every save lives in this process and is lost on exit.
//
// Data starts with an empty catalog, just like a new public deployment.
// Push subscriptions are not loaded. Provider searches are real read requests.
//
// The admin secret for this local server only is LOCAL_ADMIN_SECRET below (or $ADMIN_SECRET).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3001);
const LOCAL_ADMIN_SECRET = 'local-admin';
process.env.ADMIN_SECRET ||= LOCAL_ADMIN_SECRET;

// ---- in-memory @netlify/blobs ---------------------------------------------------------------
const stores = new Map(); // store name -> Map(key -> string)
const storeFor = name => {
  const key = typeof name === 'string' ? name : name?.name;
  if (!stores.has(key)) stores.set(key, new Map());
  return stores.get(key);
};
globalThis.__devGetStore = name => {
  const data = storeFor(name);
  return {
    async get(key, opts) {
      const value = data.get(key);
      if (value === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(value) : value;
    },
    async set(key, value) { data.set(key, String(value)); },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list(options = {}) {
      const prefix = options.prefix || '';
      return { blobs:[...data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, etag:data.get(key) })) };
    },
  };
};
// An in-memory store is always consistent, so advertise strong reads like a deployed function.
globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify(
  { siteID:'local', token:'local', uncachedEdgeURL:'https://uncached.local.test' })).toString('base64');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@netlify/blobs') {
      return { shortCircuit:true,
        url:'data:text/javascript,export const getStore = name => globalThis.__devGetStore(name);' };
    }
    return nextResolve(specifier, context);
  },
});

// ---- functions, routed by each file's config.path -------------------------------------------
const routes = [];
const functionsDir = path.join(ROOT, 'netlify', 'functions');
for (const file of fs.readdirSync(functionsDir).filter(name => name.endsWith('.js')).sort()) {
  try {
    const mod = await import(pathToFileURL(path.join(functionsDir, file)).href);
    if (typeof mod.default !== 'function' || !mod.config?.path) continue; // scheduled-only functions
    const methods = mod.config.method ? [].concat(mod.config.method).map(m => m.toUpperCase()) : null;
    for (const route of [].concat(mod.config.path)) routes.push({ path:route, methods, handler:mod.default, file });
  } catch (error) {
    console.log(`Skipped ${file}: ${error.message.split('\n')[0]}`);
  }
}

// ---- static files + netlify.toml redirects --------------------------------------------------
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.mp3':'audio/mpeg', '.woff2':'font/woff2', '.pdf':'application/pdf' };
const BLOCKED = new Set(['node_modules', 'netlify', 'tests', 'scripts']);
const REAL_ROOT = fs.realpathSync.native(ROOT);
function staticFile(pathname) {
  if (pathname === '/admin') pathname = '/admin.html';
  if (pathname === '/play' || pathname.startsWith('/teams/')) pathname = '/index.html';
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  // A backslash is a path separator on Windows, so it could smuggle "..\" past a "/"-only check;
  // a colon names an alternate data stream.
  if (/[\\:\0]/.test(decoded)) return null;
  const requested = path.resolve(ROOT, '.' + path.posix.normalize('/' + decoded));
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) return null;
  // Judge the file the filesystem actually opened, by its canonical name. Windows ignores a
  // trailing dot or space ("scripts." is "scripts") and accepts short names ("SCRIPT~1"), so the
  // requested spelling proves nothing.
  const file = fs.realpathSync.native(requested);
  const relative = path.relative(REAL_ROOT, file);
  const parts = relative.split(path.sep).filter(Boolean);
  if (!parts.length || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (parts.some(part => part.startsWith('.')) || BLOCKED.has(parts[0].toLowerCase())) return null;
  return file;
}

// Only answer requests addressed to this machine by name. A hostile web page can point its own
// domain at 127.0.0.1 (DNS rebinding) to read a local server's responses; its Host header gives
// it away.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// A page on another site can still SEND a request here even though it cannot read the answer, and
// the local admin secret is written in this file. Refuse any function call a browser marks as
// coming from elsewhere; only a plain link or address-bar visit is let through.
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map(host => `http://${host}`));
function fromAnotherSite(req) {
  const origin = req.headers.origin;
  const foreign = (origin != null && !LOCAL_ORIGINS.has(String(origin).toLowerCase()))
    || String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site';
  if (!foreign) return false;
  const visit = ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-mode'] === 'navigate';
  return !visit;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(421, { 'Content-Type':'text/plain' });
    return res.end('This local preview only answers localhost requests.');
  }
  try {
    const route = routes.find(item => item.path === url.pathname && (!item.methods || item.methods.includes(req.method)));
    if (route) {
      if (fromAnotherSite(req)) {
        res.writeHead(403, { 'Content-Type':'application/json' });
        return res.end(JSON.stringify({ error:'This local preview only accepts requests from its own pages.' }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = !['GET', 'HEAD'].includes(req.method) && chunks.length;
      const response = await route.handler(new Request(url, { method:req.method, headers:req.headers,
        body:hasBody ? Buffer.concat(chunks) : undefined }), {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const file = staticFile(url.pathname);
    if (!file) { res.writeHead(404, { 'Content-Type':'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type':TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    res.writeHead(500, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:error.message }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Local preview with functions: http://localhost:${PORT}  (admin: /admin)`);
  console.log(`Functions: ${routes.map(route => route.path).join(', ')}`);
});
