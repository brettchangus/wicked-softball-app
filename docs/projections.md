# Sunday projections

`assets/projections.js` is a pure CommonJS/browser module. The dashboard loads it as a classic script (`TournamentProjection`); `chat.js` imports the same module. Both call `analyze(snapshot)` and consume its headline, details, and one example path. No separate chat scenario math is maintained.

The restored Projections tab focuses on the highest remaining Sunday finish, not the most likely finish. Pool position is supporting information. For bracket-only events the outlook appears above the existing bracket.

## Pool positions

- Work from the merged snapshot (including manual score overrides). Count completed games once and enumerate each remaining game's home win, away win, and, when permitted, tie. Games between rivals cannot give both rivals a win or both a loss.
- Rank within the tracked pool for pool-local bracket entries, within the team's division for division brackets, or globally for tiered brackets. Do not use the display table's tracked-team-first ordering as a seed order.
- Completed, unique, contiguous official pool ranks take precedence when there are no manual overrides. If published records and game results disagree, wait for consistent data rather than inventing remaining games.
- Unresolved tiebreaks are conditional rank intervals, not proofs that a particular score combination exists. Fixed runs-allowed/runs-scored tiebreaks can settle two teams that have both finished, when those rules are verified.
- Independent groups of remaining matchups are searched separately, identical record states are merged, and their ahead/tied counts are combined to establish the seed range. Search is capped at 100,000 distinct states. An incomplete search cannot establish a pool range or eliminate a finish. Independently of that search, the bracket may prove a championship ceiling when **every** possible pool seed has a path to it.

## Rules and uncertainty

The engine reads `snapshot.meta.projectionRules`:

```json
{
  "verified": true,
  "primary": "winPercentage",
  "allowsTies": true,
  "tiebreakers": ["headToHead", "runsAllowed", "runDifferential"]
}
```

`primary` is `winPercentage` ("best record": ties count as half a win) or `wins`. Tiebreakers apply in order:

- `headToHead` — our net wins against the other team in their pool games, completed or hypothetical. It applies **only when exactly two teams are tied on record**; with three or more tied it is skipped and the next tiebreaker decides. A split or unplayed head-to-head also falls through. Because the tie group's size is known only after combining every independent matchup group, each group reports its ahead/tied counts and how a lone tied team breaks, and those are combined before the tie is resolved. Equal records that hide different head-to-head results (e.g. a three-team cycle) are kept apart in our own matchup group.
- `runsAllowed` (fewer), `runsScored` (more), `runDifferential` (higher) — settle a tie only when both teams have finished pool play with known scores; otherwise the tie stays open.
- Any other key stays unresolved; it is never skipped in favor of a later tiebreaker.

**Where the rules come from** (`netlify/functions/lib/seeding.js`, resolved per request by `snapshot.js` and `chat.js` via `withSeedingRules`):

1. An admin-saved rule set: the tournament editor's **Seeding rules** section, stored as `config.seedingRules` on the tournament (validated by `normalizeSeedingRules` in `saveEvent`).
2. Otherwise, for AST tournaments (an `allstartournaments.com` providerRef, `discovery.provider: 'ast'`, or AST metadata on the snapshot), AST's published rules (`AST_DEFAULT_SEEDING_RULES`): best record → head-to-head (two teams only) → runs allowed → run differential.
3. Otherwise none. Rules are not read from the transcribed rules PDF.

With verified rules the outlook names them ("Seeding rules: …").

The **projected bracket** (the dashboard's bracket tab via `sortStandingsTeams`, and chat's `PROJECTED BRACKETS` block) orders teams by their *current* standings with `rankByRules`, applying the same rules: record, then the tiebreakers in order, head-to-head only for a two-team record tie (never revived after a later tiebreaker narrows a larger tie), and a stable id order for anything still tied. Each division is ranked separately before its bracket is seeded. Pool tables put the tracked team first only within a group still tied after all applicable tiebreakers; better seeds and complete official ranks remain ahead. The dashboard and chat still prefer the provider's complete posted order (Tourney Machine's standings order, or NorCal's `place`, stamped as `officialPoolRank`/`officialRank` by `withPostedStandingsRanks` in `lib/snapshot.js` once a game has been played); without verified rules both fall back to wins → runs allowed → runs scored. The bracket tab's note names the rules in use.

**`won`/`lost` statuses** mean different things by source: NorCal's bracket `topScoreStatus` is the top (home) team's result, while an admin override (flagged `manual`, win/loss override) is the tracked team's result. `mergeSnapshot` applies a bracket game's override to `bracketGames` too (`withBracketGameOverrides` in `lib/snapshot.js`), translated to the feed's meaning: decisive scores become `completed`, and a bare Win/Loss becomes the top team's `won`/`lost`. So the dashboard's and chat's bracket readers show the corrected result and still read `won` as a top-team win, while `snapshot.results` keeps the override as entered (`manual`). The engine reads decisive scores first, then a manual status from the tracked team's side and any other status as the top team's.

Without verified rules, pool scenarios explicitly assume total wins and permit ties. A seed-dependent ceiling is labeled **conditional**, never a clinch or elimination. Pool-independent bracket ceilings and official assignments do not need this assumption. The tool does not provide probabilities or claim that a higher seed is the likely winner.

## Bracket paths

Pool and seed remain paired (`topPool/topSeed`, `botPool/botSeed`); the module also reads original provider labels for older multi-pool snapshots whose numeric seeds were cleared. Graphical brackets and chat preserve pool labels for entry seeds in multi-pool events (`entryPool`; a single pool's "Bracket A 1st Place" is an overall seed, so projected teams still fill it) and use game numbers for frame results; `projectionUnsupported` continues gating global predicted seed arrays, but no longer hides the Sunday outlook tab. Setup version 15 refreshes stored structures to preserve pool-local numeric seeds.

Published winner and loser edges determine all remaining paths. Actual assignments and completed results override hypothetical entry slots. A Sunday loss may leave a consolation championship reachable; a completed final becomes a final result rather than a new win-out prediction. A final's first/second place is explicitly within that final, not an invented overall tournament placement.

The engine does not trust the legacy Gold/Silver labels inferred from ascending game numbers. With multiple finals, a unique final reached by the undefeated winner routes is identified as the championship; other finals are called consolation, with their provider game numbers. Missing links, cycles, ambiguous advancement, and unordered consolation finals withhold the highest-finish claim. Once the tracked team is assigned, only brackets containing that team are validated; unrelated sister brackets cannot suppress its result.

## Verification

`tests/projections.test.mjs` covers coupled remaining matchups, settled and unsettled tiebreaks, official ranks, manual overrides, inconsistent data, bounded searches, pool-local and division-local entries, stale snapshots, Sunday losses, completed finals, missing topology, browser/Node parity, dashboard escaping, and chat formatting.
