// Add completed games from this season's tournament snapshots to the team profile history.
// External-provider games do not appear in NorCal's Team/{id} response.
const FINAL = new Set(['completed', 'final', 'won', 'lost']);

export function recentResultsFromSnapshots(snapshots = []) {
  const games = [], tournaments = [];
  for (const snap of snapshots) {
    const myId = snap?.meta?.providerTeamId;
    const eventId = snap?.meta?.eventId;
    if (myId == null || !eventId) continue;
    const eventGames = [], seen = new Set();
    const add = (key, date, topId, topName, botId, botName, topScore, botScore, status) => {
      if (!FINAL.has(String(status || '').toLowerCase()) || topScore == null || botScore == null) return;
      const isTop = String(topId) === String(myId);
      if (!isTop && String(botId) !== String(myId)) return;
      const mine = Number(isTop ? topScore : botScore);
      const theirs = Number(isTop ? botScore : topScore);
      if (!Number.isFinite(mine) || !Number.isFinite(theirs) || seen.has(key)) return;
      seen.add(key);
      eventGames.push({ key, date, eventId, event:snap.meta.name,
        oppId:isTop ? botId : topId,
        opp:String(isTop ? botName : topName).replace(/^\[\d+\]\s*/, ''),
        score:`${mine}-${theirs}`, res:mine > theirs ? 'W' : mine < theirs ? 'L' : 'T',
        myScore:mine, oppScore:theirs,
      });
    };
    Object.values(snap.pools || {}).forEach(pool => (pool.games || []).forEach(g => {
      const r = snap.results?.[g.key];
      if (r) add(g.key, g.time, g.hid, g.hn, g.aid, g.an, r.topScore, r.botScore, r.status);
    }));
    Object.values(snap.bracketGames || {}).forEach(list => (list || []).forEach(g =>
      add(g.key, g.time, g.topId, g.topName, g.botId, g.botName, g.topScore, g.botScore, g.status)));
    if (!eventGames.length) continue;
    const wins = eventGames.filter(g => g.res === 'W').length;
    const losses = eventGames.filter(g => g.res === 'L').length;
    const ties = eventGames.length - wins - losses;
    const pf = eventGames.reduce((sum, g) => sum + g.myScore, 0);
    const pa = eventGames.reduce((sum, g) => sum + g.oppScore, 0);
    games.push(...eventGames);
    tournaments.push({ id:eventId, name:snap.meta.name,
      record:`${wins}-${losses}${ties ? `-${ties}` : ''}`, pf, pa });
  }
  return { games, tournaments };
}

export function mergeRecentResults(wicked, snapshots) {
  const added = recentResultsFromSnapshots(snapshots);
  if (!added.games.length) return wicked;
  const original = wicked || {};
  const games = [...(original.games || [])];
  const tournaments = [...(original.tournaments || [])];
  const eventIds = new Set(games.map(g => String(g.eventId)));
  for (const tournament of added.tournaments) {
    if (eventIds.has(String(tournament.id))) continue;
    games.push(...added.games.filter(g => g.eventId === tournament.id));
    if (!tournaments.some(t => String(t.id) === String(tournament.id))) tournaments.push(tournament);
  }
  games.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { ...original, games, tournaments };
}
