/* Shared browser/Node projection engine. No DOM, network, or provider dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TournamentProjection = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const done = g => ['completed', 'final', 'won', 'lost'].includes(g?.status);
  // Decisive scores pick the winner. Otherwise "won"/"lost" depends on the source: a provider
  // bracket status (NorCal topScoreStatus) is the TOP team's result, while a manual override
  // (`manual`, admin win override) is the TRACKED team's result — read from myId's side.
  const winnerSide = (g, myId, topId = g.topId, botId = g.botId) => {
    if (g.topScore != null && g.botScore != null && g.topScore !== g.botScore) return g.topScore > g.botScore ? 'top' : 'bot';
    if (g.status !== 'won' && g.status !== 'lost') return null;
    const mine = g.manual && myId && botId === myId ? 'bot' : 'top';
    return g.status === 'won' ? mine : mine === 'top' ? 'bot' : 'top';
  };
  const slot = (g, side) => {
    const m = String(g[side + 'Name'] || '').match(/(?:Pool|Bracket)\s+([A-Z0-9]+)\s+(\d+).*Place/i);
    return { pool: g[side + 'Pool'] || m?.[1]?.toUpperCase() || null,
      seed: Number(g[side + 'Seed'] || m?.[2]) || null, feed: g[side + 'Game'] };
  };
  // Seeds are pool-local only when the event has several pools. A single pool still labels
  // its slots "Bracket A 1st Place", but that seed is the overall seed.
  const entryPool = (g, side, poolCount) => poolCount > 1 ? slot(g, side).pool : null;
  const RULE_LABELS = { winPercentage: 'best record (ties count as half a win)', wins: 'most wins',
    headToHead: 'head-to-head (two-team ties only)', runsAllowed: 'fewest runs allowed',
    runsScored: 'most runs scored', runDifferential: 'best run differential' };
  const describeRules = rules => [rules.primary, ...(rules.tiebreakers || [])]
    .map(key => RULE_LABELS[key] || key).join(' → ').replace(/^./, c => c.toUpperCase());

  // Groups of a list with equal value, best (highest) value first, input order kept within each.
  const splitBy = (list, value) => {
    const groups = new Map();
    for (const item of list) { const v = value(item); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(item); }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([, group]) => group);
  };
  // Order teams by their CURRENT standings under verified rules — the projected bracket's seed
  // order, unlike poolPositions, which covers every possible remaining result. Rows carry
  // { id, w, l, ties|t, ra, rf }. Head-to-head (from the snapshot's completed pool games) applies
  // only when exactly two teams are tied on record, matching poolPositions. Teams still tied after
  // every tiebreaker keep a stable id order so the bracket is deterministic.
  function rankGroupsByRules(teams, rules, snap) {
    const myId = snap?.meta?.providerTeamId || snap?.meta?.myId;
    const ties = t => t.ties ?? t.t ?? 0;
    const record = t => rules.primary === 'winPercentage'
      ? (t.w + ties(t) / 2) / ((t.w + (t.l || 0) + ties(t)) || 1) : t.w;
    const beat = new Map(), games = new Map();
    for (const p of Object.values(snap?.pools || {})) for (const g of p.games || []) games.set(g.key, g);
    for (const g of games.values()) {
      const r = snap.results?.[g.key], win = done(r) && winnerSide(r, myId, g.hid, g.aid);
      if (!win || !g.hid || !g.aid) continue;
      const key = win === 'top' ? g.hid + '|' + g.aid : g.aid + '|' + g.hid;
      beat.set(key, (beat.get(key) || 0) + 1);
    }
    const net = (a, b) => (beat.get(a + '|' + b) || 0) - (beat.get(b + '|' + a) || 0);
    const value = { runsAllowed: t => -(t.ra || 0), runsScored: t => t.rf || 0, runDifferential: t => (t.rf || 0) - (t.ra || 0) };
    const byId = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const breakTie = (group, keys, pair) => {
      if (group.length < 2 || !keys.length) return [byId(group)];
      const [key, ...rest] = keys;
      if (key === 'headToHead') {
        const d = pair ? net(group[0].id, group[1].id) : 0;
        return d ? (d > 0 ? [...group] : [group[1], group[0]]).map(t => [t]) : breakTie(group, rest, pair);
      }
      if (!value[key]) return [byId(group)];
      return splitBy(group, value[key]).flatMap(sub => breakTie(sub, rest, pair));
    };
    return splitBy(teams, record).flatMap(group => breakTie(group, rules.tiebreakers || [], group.length === 2));
  }

  // Preserve unresolved groups for display-only tracked-team-first ordering. Seed callers use
  // the deterministic flattened order and supply only the teams in their seeding division.
  function rankByRules(teams, rules, snap) {
    return rankGroupsByRules(teams, rules, snap).flat();
  }

  // A leaf is one consistent set of results: opponents cannot both win the same game.
  // Unknown score-based tiebreaks produce CONDITIONAL positions, never a proof of attainability.
  function poolPositions(snap, myId, { maxNodes = 100000 } = {}) {
    const pools = snap.pools || {}, brackets = snap.brackets || [];
    const roster = Object.entries(pools).flatMap(([pool, p]) => (p.teams || []).map(t => ({ ...t, pool })));
    const me = roster.find(t => t.id === myId);
    if (!me) return { available: false, reason: 'Waiting for the tracked team’s pool schedule.' };
    const local = Object.keys(pools).length > 1 && brackets.some(b => (b.frame || []).some(g =>
      ['top', 'bot'].some(side => slot(g, side).pool)));
    const division = brackets.some(b => b.division) ? me.level : null;
    if (brackets.some(b => b.division) && !division)
      return { available: false, reason: 'The team’s bracket division is not known yet.' };
    const ranking = roster.filter(t => local ? t.pool === me.pool : division ? t.level === division : true);
    const scope = { local, pool: me.pool, division, count: ranking.length };
    const ids = new Set(ranking.map(t => t.id));
    const games = [...new Map(Object.values(pools).flatMap(p => p.games || []).map(g => [g.key, g])).values()];
    const relevant = games.filter(g => ids.has(g.hid) || ids.has(g.aid));
    if (!relevant.length) return { ...scope, available: false, reason: 'Pool games have not been published.' };
    const pending = relevant.filter(g => !done(snap.results?.[g.key]));
    const rules = snap.meta?.projectionRules;
    const verified = rules?.verified === true && ['wins', 'winPercentage'].includes(rules.primary);
    const primary = verified ? rules.primary : 'wins';
    const allowsTies = verified ? rules.allowsTies !== false : true;
    const rows = new Map();
    const manual = relevant.some(g => snap.results?.[g.key]?.manual);
    for (const t of ranking) {
      const schedule = relevant.filter(g => g.hid === t.id || g.aid === t.id);
      const completed = schedule.filter(g => done(snap.results?.[g.key]));
      const s = (pools[t.pool].standings || []).find(s => (s.teamID || s._key) === t.id);
      let w = 0, l = 0, ties = 0, ra = 0, rf = 0, scoresKnown = true;
      for (const g of completed) {
        const r = snap.results[g.key], side = g.hid === t.id ? 'top' : 'bot', win = winnerSide(r, myId, g.hid, g.aid);
        if (win) { if (side === win) w++; else l++; } else if (r.topScore != null && r.botScore != null) ties++;
        else return { ...scope, available: false, reason: 'A completed pool game is missing its result.' };
        if (r.topScore == null || r.botScore == null) scoresKnown = false;
        rf += Number(r[side + 'Score'] || 0); ra += Number(r[(side === 'top' ? 'bot' : 'top') + 'Score'] || 0);
      }
      if (!manual && s?.record) {
        const [sw = 0, sl = 0, st = 0] = s.record.split('-').map(Number);
        if (sw !== w || sl !== l || st !== ties) return { ...scope, available: false,
          reason: 'Standings and completed game results are not in sync yet. Waiting for the next score update.' };
      }
      rows.set(t.id, { ...t, w, l, ties, ra, rf, scoresKnown, total: schedule.length,
        remaining: schedule.length - completed.length,
        official: manual ? null : (local || Object.keys(pools).length === 1 ? s?.officialPoolRank ?? s?.officialRank : null) });
    }
    const mine = rows.get(myId);
    const allFinal = pending.length === 0;
    const official = allFinal && [...rows.values()].every(t => Number.isInteger(Number(t.official)) && Number(t.official) > 0 && Number(t.official) <= rows.size)
      && new Set([...rows.values()].map(t => Number(t.official))).size === rows.size;
    if (official) return { ...scope, available: true, complete: true,
      best: Number(mine.official), worst: Number(mine.official), candidates: [{ seed: Number(mine.official), conditional: false, witness: [] }], notes: [] };
    const notes = verified ? [`Seeding rules: ${describeRules(rules)}.`]
      : ['Seeding rules are not verified: scenarios assume total wins rank first and pool ties are allowed.'];
    const metric = t => primary === 'winPercentage' ? (t.w + t.ties / 2) / (t.total || 1) : t.w;
    const tiebreakers = verified ? rules.tiebreakers || [] : [];
    const useHeadToHead = tiebreakers.includes('headToHead');
    // Our net head-to-head wins against each team: completed games now, pending ones per scenario.
    const h2h = new Map();
    for (const g of relevant) {
      if (!done(snap.results?.[g.key]) || (g.hid !== myId && g.aid !== myId)) continue;
      const other = g.hid === myId ? g.aid : g.hid, win = winnerSide(snap.results[g.key], myId, g.hid, g.aid);
      if (win) h2h.set(other, (h2h.get(other) || 0) + ((win === 'top') === (g.hid === myId) ? 1 : -1));
    }
    // How a team tied with us on record breaks against us: >0 it finishes ahead, <0 behind,
    // 0 unresolved. Head-to-head applies only to a two-team tie ("pair"); with three or more
    // tied it is skipped. Score tiebreakers settle only once both teams are done; an unknown
    // tiebreaker stays unresolved rather than being skipped.
    const tieClass = (t, net, pair) => {
      for (const key of tiebreakers) {
        if (key === 'headToHead') { if (pair && net) return -net; continue; }
        if (!['runsAllowed', 'runsScored', 'runDifferential'].includes(key)) return 0;
        if (t.remaining || mine.remaining || !t.scoresKnown || !mine.scoresKnown) return 0;
        const diff = key === 'runsAllowed' ? mine.ra - t.ra : key === 'runsScored' ? t.rf - mine.rf : (t.rf - t.ra) - (mine.rf - mine.ra);
        if (diff) return diff;
      }
      return 0;
    };
    // Independent matchup components do not share result choices. Enumerate each once,
    // merging identical record states, then combine counts ahead/tied rather than games.
    const parent = new Map([...rows.keys()].map(id => [id, id]));
    const find = id => parent.get(id) === id ? id : find(parent.get(id));
    for (const g of pending) if (rows.has(g.hid) && rows.has(g.aid)) parent.set(find(g.hid), find(g.aid));
    const groups = new Map();
    for (const t of rows.values()) {
      const key = find(t.id);
      if (!groups.has(key)) groups.set(key, { teams: [], games: [] });
      groups.get(key).teams.push(t);
    }
    pending.forEach((g, index) => groups.get(find(rows.has(g.hid) ? g.hid : g.aid)).games.push({ g, index }));
    let nodes = 0, exhausted = false;
    const components = [];
    for (const group of groups.values()) {
      const states = [], seen = new Set(), choices = [];
      // Equal records can hide different head-to-head results (e.g. a three-team cycle),
      // so our component keeps those states apart when head-to-head is a tiebreaker.
      const trackH2H = useHeadToHead && group.teams.includes(mine);
      function visit(i) {
        const key = i + ':' + group.teams.map(t => primary === 'wins' ? t.w : 2 * t.w + t.ties).join(',')
          + (trackH2H ? '|' + group.teams.map(t => h2h.get(t.id) || 0).join(',') : '');
        if (seen.has(key)) return;
        seen.add(key);
        if (++nodes > maxNodes) { exhausted = true; return; }
        if (i === group.games.length) {
          states.push({ metrics: group.teams.map(metric), nets: group.teams.map(t => h2h.get(t.id) || 0), witness: [...choices] });
          return;
        }
        const { g, index } = group.games[i], h = rows.get(g.hid), a = rows.get(g.aid);
        const other = g.hid === myId ? g.aid : g.aid === myId ? g.hid : null;
        for (const outcome of allowsTies ? ['home', 'away', 'tie'] : ['home', 'away']) {
          const hk = outcome === 'home' ? 'w' : outcome === 'away' ? 'l' : 'ties';
          const ak = outcome === 'away' ? 'w' : outcome === 'home' ? 'l' : 'ties';
          const swing = other && outcome !== 'tie' ? ((outcome === 'home') === (g.hid === myId) ? 1 : -1) : 0;
          if (h) h[hk]++; if (a) a[ak]++; choices.push({ index, outcome });
          if (swing) h2h.set(other, (h2h.get(other) || 0) + swing);
          visit(i + 1);
          if (swing) h2h.set(other, h2h.get(other) - swing);
          choices.pop(); if (h) h[hk]--; if (a) a[ak]--;
          if (exhausted) return;
        }
      }
      visit(0);
      if (exhausted) break;
      components.push({ ...group, states });
    }
    if (exhausted) return { ...scope, available: false, reason: 'Too many remaining distinct records to establish the pool-seed range yet. Check again as pool games finish.' };
    const own = components.find(c => c.teams.includes(mine));
    const mineIndex = own.teams.indexOf(mine), candidates = new Map();
    // Per component: teams with a better record (ahead), teams tied with us on record (tied),
    // how those tied teams break with three or more tied (groupAhead/groupOpen), and — when the
    // component holds the only tied team — how that two-team tie breaks (pair).
    const counts = (component, state, myMetric) => {
      let ahead = 0, tied = 0, groupAhead = 0, groupOpen = 0, pair = 0;
      component.teams.forEach((t, i) => {
        if (t.id === myId) return;
        const diff = state.metrics[i] - myMetric;
        if (diff > 0) { ahead++; return; }
        if (diff < 0) return;
        tied++;
        const group = tieClass(t, state.nets[i], false);
        if (group > 0) groupAhead++; else if (group === 0) groupOpen++;
        pair = Math.sign(tieClass(t, state.nets[i], true));
      });
      return { ahead, tied, groupAhead, groupOpen, pair: tied === 1 ? pair : 0, witness: state.witness };
    };
    const keyOf = c => [c.ahead, c.tied, c.groupAhead, c.groupOpen, c.pair].join(':');
    const merge = (l, r) => ({ ahead: l.ahead + r.ahead, tied: l.tied + r.tied, groupAhead: l.groupAhead + r.groupAhead,
      groupOpen: l.groupOpen + r.groupOpen, pair: l.tied ? (r.tied ? 0 : l.pair) : r.pair, witness: [...l.witness, ...r.witness] });
    // The whole tie group's size is known only after combining components.
    const resolve = c => c.tied === 0 ? { ahead: c.ahead, uncertain: 0 }
      : c.tied === 1 ? { ahead: c.ahead + (c.pair > 0), uncertain: c.pair === 0 ? 1 : 0 }
      : { ahead: c.ahead + c.groupAhead, uncertain: c.groupOpen };
    const ownStates = new Map();
    for (const state of own.states) {
      const myMetric = state.metrics[mineIndex], c = counts(own, state, myMetric);
      ownStates.set(myMetric + ':' + keyOf(c), { ...c, myMetric });
    }
    const summaries = new Map();
    for (const state of ownStates.values()) {
      let combined = new Map([[keyOf(state), state]]);
      for (const component of components.filter(c => c !== own)) {
        const cacheKey = components.indexOf(component) + ':' + state.myMetric;
        if (!summaries.has(cacheKey)) {
          const summary = new Map();
          for (const option of component.states) {
            const c = counts(component, option, state.myMetric);
            summary.set(keyOf(c), c);
          }
          summaries.set(cacheKey, [...summary.values()]);
        }
        const next = new Map();
        for (const left of combined.values()) for (const right of summaries.get(cacheKey)) {
          const c = merge(left, right), key = keyOf(c);
          if (!next.has(key)) next.set(key, c);
        }
        combined = next;
      }
      for (const raw of combined.values()) for (let c = { ...resolve(raw), witness: raw.witness }, seed = c.ahead + 1; seed <= c.ahead + c.uncertain + 1; seed++) {
        const conditional = !verified || c.uncertain > 0;
        if (!candidates.has(seed) || (candidates.get(seed).conditional && !conditional))
          candidates.set(seed, { seed, conditional, witness: [...c.witness].sort((a, b) => a.index - b.index).map(choice => {
            const g = pending[choice.index];
            return { key: g.key, home: g.hn || g.hid, away: g.an || g.aid, outcome: choice.outcome };
          }) });
      }
    }
    const list = [...candidates.values()].sort((a, b) => a.seed - b.seed);
    if (list.some(c => c.conditional)) notes.push('Tied records may depend on scores or tournament tiebreakers; conditional seeds are not guaranteed to be achievable.');
    return { ...scope, available: true, complete: allFinal, best: list[0]?.seed,
      worst: list.at(-1)?.seed, candidates: list, notes };
  }

  function bracketPaths(snap, myId, positions) {
    const paths = [], warnings = new Set();
    const brackets = snap.brackets || [];
    const assignedBrackets = new Set(brackets.filter(b => [...(b.frame || []), ...(snap.bracketGames?.[b.level] || [])]
      .some(g => g.topId === myId || g.botId === myId)));
    const assigned = assignedBrackets.size > 0;
    let offset = 0;
    for (const b of brackets) {
      const currentOffset = offset;
      offset += b.size || 0;
      if (assigned ? !assignedBrackets.has(b) : positions.division && b.division !== positions.division) continue;
      const frame = (b.frame || []).map(g => {
        const live = (snap.bracketGames?.[b.level] || []).find(x => (g.key != null && x.key === g.key)
          || Math.abs(Number(x.gameNo)) === Math.abs(Number(g.gameNo)));
        return { ...g, ...live, ...(snap.results?.[live?.key || g.key] || {}),
          topGame: g.topGame, botGame: g.botGame, gameNo: Math.abs(Number(g.gameNo)) };
      });
      if (!frame.length) { warnings.add('A published bracket advancement tree is required to establish the Sunday finish.'); continue; }
      const byNo = new Map(frame.map(g => [g.gameNo, g]));
      const successors = (no, win) => frame.filter(g => [g.topGame, g.botGame].includes(win ? no : -no));
      const hasMissingFeed = frame.some(g => ['top', 'bot'].some(side => slot(g, side).feed != null && !byNo.has(Math.abs(slot(g, side).feed))));
      const missingSlot = frame.some(g => ['top', 'bot'].some(side => {
        const s = slot(g, side); return !s.seed && s.feed == null && !g[side + 'Id'];
      }));
      if (hasMissingFeed || missingSlot || b.topologyKnown === false) { warnings.add('Some bracket advancement links are missing; a highest finish cannot be confirmed.'); continue; }
      const roots = frame.filter(g => !successors(g.gameNo, true).length);
      // Identify a championship by the published winner edges, NEVER by game numbering.
      const entries = frame.filter(g => ['top', 'bot'].some(side => slot(g, side).seed || (g[side + 'Id'] && slot(g, side).feed == null)));
      function winnerRoot(g, seen = new Set()) {
        if (seen.has(g.gameNo)) return null;
        seen.add(g.gameNo);
        const next = successors(g.gameNo, true);
        return next.length === 0 ? g.gameNo : next.length === 1 ? winnerRoot(next[0], seen) : null;
      }
      const undefeatedRoots = new Set(entries.map(g => winnerRoot(g)));
      const championship = undefeatedRoots.size === 1 && !undefeatedRoots.has(null) ? [...undefeatedRoots][0] : null;
      if (roots.length > 1 && championship == null) warnings.add('The published finals do not establish a championship/consolation order.');
      const gamePrefix = snap.meta?.provider === 'norcal' ? 'G' : 'B';
      const terminalLabel = g => roots.length === 1 ? (b.label || 'Championship')
        : g.gameNo === championship ? `Championship (final ${gamePrefix}${g.gameNo})` : `Consolation (final ${gamePrefix}${g.gameNo})`;
      const starts = [];
      if (assigned) {
        const mine = frame.filter(g => g.topId === myId || g.botId === myId);
        // Start at the first assigned game; completed results determine the only remaining route.
        for (const g of mine.filter(g => !mine.some(p => [g.topGame, g.botGame].some(ref => Math.abs(ref || 0) === p.gameNo))))
          starts.push({ g, side: g.topId === myId ? 'top' : 'bot', conditional: false, witness: [], seed: null });
      } else if (positions.available) {
        for (const candidate of positions.candidates) {
          const seed = positions.local ? candidate.seed : candidate.seed - (positions.division ? 0 : currentOffset);
          if (seed < 1 || (!positions.local && seed > b.size)) continue;
          for (const g of frame) for (const side of ['top', 'bot']) {
            const s = slot(g, side);
            if (s.seed === seed && (!positions.local || s.pool === positions.pool) && (!g[side + 'Id'] || g[side + 'Id'] === myId))
              starts.push({ ...candidate, g, side });
          }
        }
      }
      function walk(g, start, steps, seen, incomingSide = null) {
        if (paths.length >= 4096) { warnings.add('The bracket has too many possible paths to establish a ceiling.'); return; }
        if (seen.has(g.gameNo)) { warnings.add('The published bracket contains a cycle.'); return; }
        const visited = new Set(seen).add(g.gameNo);
        if (incomingSide && g[incomingSide + 'Id'] && g[incomingSide + 'Id'] !== myId) return;
        if (g.topId && g.botId && g.topId !== myId && g.botId !== myId) return;
        let outcomes = [true, false];
        if (done(g)) {
          const winner = winnerSide(g, myId);
          if (!winner || (g.topId !== myId && g.botId !== myId)) { warnings.add('A completed bracket game is missing a decisive result or assignment.'); return; }
          outcomes = [g[winner + 'Id'] === myId];
        }
        for (const win of outcomes) {
          const next = successors(g.gameNo, win);
          const mySide = g.topId === myId ? 'top' : g.botId === myId ? 'bot' : incomingSide;
          const opponentSide = mySide === 'top' ? 'bot' : mySide === 'bot' ? 'top' : null;
          const opponentSlot = opponentSide ? slot(g, opponentSide) : {};
          let opponent = opponentSide ? g[opponentSide + 'Name'] : null;
          if (!opponent && opponentSlot.feed != null) {
            const feeder = byNo.get(Math.abs(opponentSlot.feed)), won = feeder && done(feeder) && winnerSide(feeder, myId);
            const side = won && (opponentSlot.feed > 0 ? won : won === 'top' ? 'bot' : 'top');
            opponent = side && (feeder[side + 'Name'] || feeder[side + 'Id'])
              || `${opponentSlot.feed > 0 ? 'Winner' : 'Loser'} of ${snap.meta?.provider === 'norcal' ? 'G' : 'B'}${Math.abs(opponentSlot.feed)}`;
          }
          if (!opponent && opponentSlot.seed) opponent = `${opponentSlot.pool ? `Pool ${opponentSlot.pool} ` : 'Seed '}#${opponentSlot.seed}`;
          const path = done(g) ? steps : [...steps, `${win ? 'Win' : 'Lose'} ${snap.meta?.provider === 'norcal' ? 'G' : 'B'}${Math.abs(g.gameNo)}${opponent ? ` vs ${opponent}` : ''}`];
          if (next.length > 1) { warnings.add('A bracket result has ambiguous advancement links.'); continue; }
          if (next.length) walk(next[0], start, path, visited, next[0].topGame === (win ? g.gameNo : -g.gameNo) ? 'top' : 'bot');
          else {
            const final = roots.some(r => r.gameNo === g.gameNo);
            // Nonfinal exits have no reliable numbered placement. Preserve that uncertainty.
            paths.push({ bracket: b.label, label: final ? `${terminalLabel(g)} — ${win ? '1st' : '2nd'} place` : 'Eliminated before the final',
              tier: brackets.indexOf(b), championship: g.gameNo === championship || roots.length === 1,
              final: final ? g.gameNo : null, place: final ? (win ? 1 : 2) : null,
              seed: start.seed, conditional: start.conditional, witness: start.witness, steps: path });
          }
        }
      }
      starts.forEach(start => walk(start.g, start, [], new Set(), start.side));
    }
    paths.sort((a, b) => a.tier - b.tier || Number(b.championship) - Number(a.championship)
      || (a.place || 99) - (b.place || 99) || Number(a.conditional) - Number(b.conditional) || a.steps.length - b.steps.length);
    if (paths.length && !paths.some(p => p.championship) && new Set(paths.filter(p => p.final != null).map(p => `${p.tier}:${p.final}`)).size > 1)
      warnings.add('Multiple consolation finals remain reachable, but their relative placements are not published.');
    return { paths, warnings: [...warnings], assigned };
  }

  function analyze(snap, options = {}) {
    const myId = options.myId || snap?.meta?.providerTeamId || snap?.meta?.myId;
    if (!snap || !myId) return { headline: 'Waiting for tournament data.', details: [], paths: [] };
    const positions = poolPositions(snap, myId, options);
    let bracket = bracketPaths(snap, myId, positions);
    let best = bracket.paths[0], seedIndependent = false;
    // When EVERY possible entry seed can reach the same best final, the Sunday ceiling
    // doesn't require predicting pool order at all. This also works before a large pool
    // search completes. Retain the original conditional path, if one was computed.
    if (!bracket.assigned && positions.count && !bracket.warnings.length) {
      const allSeeds = bracketPaths(snap, myId, { ...positions, available: true,
        candidates: Array.from({ length: positions.count }, (_, i) => ({ seed: i + 1, conditional: false, witness: [] })) });
      const top = allSeeds.paths[0];
      if (top?.place === 1 && !allSeeds.warnings.length &&
          new Set(allSeeds.paths.filter(p => p.label === top.label).map(p => p.seed)).size === positions.count) {
        seedIndependent = true;
        if (!best || best.label !== top.label) { best = { ...top, seed: null, steps: [], witness: [] }; bracket = allSeeds; }
      }
    }
    const details = [];
    let headline = 'Highest finish not established yet';
    if (best && !bracket.warnings.length) headline = `${best.conditional && !seedIndependent ? 'Conditional ceiling' : 'Highest finish still possible'}: ${best.label}`;
    if (seedIndependent) details.push('Every pool seed has a path to this finish. Pool position changes the route, not the highest finish available.');
    if (positions.available && !bracket.assigned) {
      details.push(`${positions.local ? `Pool ${positions.pool} position` : 'Pool seed'}: ${positions.best === positions.worst ? `#${positions.best}` : `#${positions.best}–#${positions.worst}`}${positions.candidates.some(c => c.conditional) ? ' (conditional)' : ''}.`);
      details.push(...positions.notes);
    } else if (!bracket.assigned) details.push(positions.reason);
    details.push(...bracket.warnings);
    if (!best && !bracket.warnings.length) details.push('No complete path from the team’s entry slot to a published final is available yet.');
    const requirements = best && !bracket.warnings.length ? [
      ...(seedIndependent && !best.seed ? ['Win through the championship path from the eventual pool entry slot. Opponents depend on the final pool positions.'] : []),
      ...(best.seed && !(positions.complete && !best.conditional) ? [`Finish ${positions.local ? `Pool ${positions.pool} in position` : 'pool play as seed'} #${best.seed}${best.conditional ? ' (requires the applicable tiebreaks/rules to permit this position)' : ''}.`] : []),
      ...best.witness.map(g => g.outcome === 'tie' ? `${g.home} and ${g.away} tie.` : `${g.outcome === 'home' ? g.home : g.away} beats ${g.outcome === 'home' ? g.away : g.home}.`),
      ...best.steps,
    ] : [];
    if (requirements.length) details.push('The listed results are one path to this finish, not the only possible path.');
    if (best && !best.steps.length && bracket.assigned && !bracket.warnings.length) headline = `Final result: ${best.label}`;
    return { headline, details: details.filter(Boolean), requirements, positions, paths: bracket.paths, best: bracket.warnings.length ? null : best || null };
  }
  function describe(result) {
    return [result.headline, ...result.details, ...(result.requirements?.length ? ['One path to this finish:', ...result.requirements.map(s => `- ${s}`)] : [])].join('\n');
  }
  return { analyze, describe, poolPositions, bracketPaths, slotIdentity: slot, entryPool, describeRules, rankByRules, rankGroupsByRules };
});
