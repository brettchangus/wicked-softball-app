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
