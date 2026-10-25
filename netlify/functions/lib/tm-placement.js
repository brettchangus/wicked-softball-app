// Mirrored in index.html; only published bracket feeds establish a finish.
export function tourneyMachinePlacement(brackets, games, myId) {
  const completed = g => ['completed','won','lost','final'].includes(g.status);
  const mine = games.filter(g => (g.topId === myId || g.botId === myId) && completed(g));
  const last = mine.sort((a,b) => String(a.time || '').localeCompare(String(b.time || ''))).at(-1);
  if (!last || last.topScore == null || last.botScore == null || last.topScore === last.botScore) return null;
  const won = last.topId === myId ? last.topScore > last.botScore : last.botScore > last.topScore;
  for (const b of brackets) {
    if (b.topologyKnown !== true) continue;
    if (!b.frame?.some(g => g.key === last.key)) continue;
    const no = Number(last.gameNo);
    const continues = b.frame.some(g => [g.topGame,g.botGame].includes(won ? no : -no));
    if (continues) return null;
    const roots = Object.entries(b.placementGames || {});
    for (const [tier, ref] of roots) {
      const finalNo = Number(String(ref).replace(/^B/,''));
      const label = roots.length === 1 ? `${b.label} Bracket` : `${tier[0].toUpperCase()}${tier.slice(1)} Bracket`;
      if (no === finalNo) return { label, emoji:'🏆', place:won ? '1st Place' : '2nd Place' };
      const final = b.frame.find(g => Number(g.gameNo) === finalNo);
      if (!won && final && [final.topGame,final.botGame].includes(no)) return { label, emoji:'🏆', place:'3rd Place' };
    }
  }
  return null;
}

const isFinal = st => st === 'completed' || st === 'won' || st === 'lost';
// Bracket games with the admin's manual score overrides (keyed by game key) applied, so a
// corrected result decides the finish the same way it does on the dashboard.
export function withBracketOverrides(bracketGames = {}, overrides = {}) {
  if (!overrides || !Object.keys(overrides).length) return bracketGames;
  return Object.fromEntries(Object.entries(bracketGames).map(([level, games]) =>
    [level, (games || []).map(g => overrides[g.key] ? { ...g, ...overrides[g.key] } : g)]));
}
// One team's finish in a tournament once its bracket run is complete: {label,emoji,place}, or null
// with no bracket games yet or while still playing. Tourney Machine uses its published feeds;
// NorCal uses the bracket's published frame (single or double elimination) to tell a finished
// run from one still playing and to find the final, falling back to game numbers. Mirrored by
// wickedBracketPlacement in index.html. Wicked's captured placement (scores.js) and the scouting star
// rating both use it; pass the event's overrides so a corrected score counts.
export function teamPlacement(structure, results, myId, overrides = {}) {
  const bracketGames = withBracketOverrides(results?.bracketGames || {}, overrides);
  if (structure.meta?.provider === 'tourneymachine') {
    return tourneyMachinePlacement(structure.brackets || [], Object.values(bracketGames).flat(), myId);
  }
  for (const b of structure.brackets || []) {
    const games = bracketGames[b.level] || [];
    const mine = games.filter(g => g.topId === myId || g.botId === myId);
    if (!mine.length) continue;

    if (mine.some(g => !isFinal(g.status))) return null; // still playing

    const lastGame = mine.reduce((a, c) => ((a.time || '') > (c.time || '') ? a : c));
    const iWon = lastGame.topId === myId
      ? (lastGame.topScore ?? 0) > (lastGame.botScore ?? 0)
      : (lastGame.botScore ?? 0) > (lastGame.topScore ?? 0);

    const label = `${b.label} Bracket`;
    // NorCal frames reference games by number with a sign: +N is game N's winner, -N its loser.
    // A losers-bracket game is itself numbered -N; its number for references is N.
    const frame = b.frame || [];
    const refs = frame.flatMap(g => [g.topGame, g.botGame]).filter(n => n != null).map(Number);
    const no = Math.abs(Number(lastGame.gameNo));
    // A later game takes this result (a win advances; in double elimination a loss can too):
    // still playing, even before that game lists the team.
    if (refs.includes(iWon ? no : -no)) return null;
    // The final: the frame's only game nothing references; otherwise the highest game number
    // anywhere, or the last game of an N-team single-elimination bracket (N-1 games).
    const fed = new Set(refs.map(n => Math.abs(n)));
    const roots = frame.map(g => Math.abs(Number(g.gameNo))).filter(n => !fed.has(n));
    const finalNo = roots.length === 1 ? roots[0]
      : Math.max(...games.map(g => Math.abs(Number(g.gameNo)) || 0), ...frame.map(g => Math.abs(Number(g.gameNo)) || 0), (Number(b.size) || 0) - 1);

    // Winner — only of the final.
    if (iWon) {
      return no === finalNo ? { label, emoji: '🏆', place: '1st Place' } : null;
    }

    // Runner-up
    if (no === finalNo) {
      return { label, emoji: '🏆', place: '2nd Place' };
    }

    // Third place: lost (and was eliminated in) a game whose winner plays the final
    const final = frame.find(g => Math.abs(Number(g.gameNo)) === finalNo);
    const semifinal = final ? [final.topGame, final.botGame].map(n => Math.abs(Number(n))).includes(no) : finalNo - no === 1;
    if (semifinal) {
      return { label, emoji: '🏆', place: '3rd Place' };
    }

    // Everything else: compute placement dynamically
    const placeNumber = finalNo - no + 2;
    // Explanation:
    //   final → 2nd place loss
    //   final-1 → 3rd place loss
    //   final-2 → 4th place loss
    //   final-3 → 5th place loss
    //   etc.

    const suffix =
      placeNumber === 1 ? '1st' :
      placeNumber === 2 ? '2nd' :
      placeNumber === 3 ? '3rd' :
      `${placeNumber}th`;

    return {
      label,
      emoji: '🎖️',
      place: `${suffix} Place`
    };
  }

  return null;
}
