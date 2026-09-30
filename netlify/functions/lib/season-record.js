// Count the tracked team's finalized games in each tournament snapshot. The same game can
// appear in a pool schedule and a bracket feed, so a tournament's game keys are counted once.
const FINAL = new Set(['completed', 'final', 'won', 'lost']);

export function tournamentRecord(snapshot) {
  const myId = snapshot?.meta?.providerTeamId;
  const record = { wins:0, losses:0, ties:0 };
  if (myId == null) return record;
  const seen = new Set();
  const count = (key, topId, botId, topScore, botScore, status) => {
    if (!FINAL.has(String(status || '').toLowerCase())) return;
    if (String(topId) !== String(myId) && String(botId) !== String(myId)) return;
    if (topScore == null || botScore == null) return;
    const top = Number(topScore), bot = Number(botScore);
    if (!Number.isFinite(top) || !Number.isFinite(bot)) return;
    if (key != null) {
      if (seen.has(String(key))) return;
      seen.add(String(key));
    }
    const mine = String(topId) === String(myId) ? top : bot;
    const theirs = String(topId) === String(myId) ? bot : top;
    if (mine > theirs) record.wins++;
    else if (mine < theirs) record.losses++;
    else record.ties++;
  };
  Object.values(snapshot.pools || {}).forEach(pool => (pool.games || []).forEach(game => {
    const result = snapshot.results?.[game.key];
    if (result) count(game.key, game.hid, game.aid,
      result.topScore, result.botScore, result.status);
  }));
  Object.values(snapshot.bracketGames || {}).forEach(list => (list || []).forEach(game =>
    count(game.key, game.topId, game.botId, game.topScore, game.botScore, game.status)));
  return record;
}

export function seasonRecord(snapshots) {
  const total = { wins:0, losses:0, ties:0 };
  for (const snapshot of snapshots) {
    const record = tournamentRecord(snapshot);
    total.wins += record.wins;
    total.losses += record.losses;
    total.ties += record.ties;
  }
  return `${total.wins}-${total.losses}${total.ties ? `-${total.ties}` : ''}`;
}

// NorCal's Team/{id} record covers the whole season, including games outside this app's
// tournament list. Add only games from external providers, which that record cannot include.
// If the team profile is unavailable, the snapshots are the best record we can serve.
export function seasonRecordWithExternal(wicked, snapshots) {
  const match = /^\s*(\d+)[-–](\d+)(?:[-–](\d+))?\s*$/.exec(String(wicked?.season || ''));
  if (!match) return seasonRecord(snapshots);
  const total = { wins:Number(match[1]), losses:Number(match[2]), ties:Number(match[3] || 0) };
  const historyEventIds = new Set((wicked?.games || []).map(game => String(game.eventId)));
  for (const snapshot of snapshots) {
    const provider = snapshot?.meta?.provider;
    if (!provider || provider === 'norcal' || historyEventIds.has(String(snapshot.meta.eventId))) continue;
    const record = tournamentRecord(snapshot);
    total.wins += record.wins;
    total.losses += record.losses;
    total.ties += record.ties;
  }
  return `${total.wins}-${total.losses}${total.ties ? `-${total.ties}` : ''}`;
}
