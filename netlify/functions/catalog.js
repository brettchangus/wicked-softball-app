import { ensureScopedModel } from './lib/snapshot.js';
import { publicCatalog } from './lib/context.js';

export default async function handler() {
  const catalog = await ensureScopedModel();
  return new Response(JSON.stringify(publicCatalog(catalog)), {
    headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' },
  });
}

export const config = { path:'/api/catalog' };
