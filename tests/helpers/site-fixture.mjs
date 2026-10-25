// Synthetic site records for tests; deployed sites still start empty.
export async function seedTestSite() {
  const storage = await import('../../netlify/functions/lib/snapshot.js');
  const { buildDefaultModel } = await import('../../netlify/functions/lib/context.js');
  const seasonData = Array.from({ length:8 }, (_, i) => ({ key:`event-${i}`, name:`Example Cup ${i}`, providerRef:String(100+i), startDate:'2026-09-12', endDate:'2026-09-13' }));
  const { catalog, team, season } = buildDefaultModel({ seasonData }, '100');
  await storage.writeCatalog(catalog);
  await storage.writeTeam(team);
  await storage.writeSeason(season);
}
