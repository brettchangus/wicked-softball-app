// Per-tournament pool seeding rules for the Sunday projection engine (assets/projections.js).
// An admin-saved rule set (event config `seedingRules`) wins; AST tournaments otherwise use
// AST's published defaults; any other tournament has no verified rules, so the engine stays
// conservative. Resolved rules are served as `snapshot.meta.projectionRules`.

export const SEEDING_PRIMARY = ['winPercentage', 'wins'];
export const SEEDING_TIEBREAKERS = ['headToHead', 'runsAllowed', 'runsScored', 'runDifferential'];

// AST: 1. best record  2. head-to-head (two teams only; not used for a three-team tie)
// 3. runs allowed  4. run differential.
export const AST_DEFAULT_SEEDING_RULES = Object.freeze({
  primary:'winPercentage', allowsTies:true,
  tiebreakers:Object.freeze(['headToHead', 'runsAllowed', 'runDifferential']),
});

// Validate an admin-entered rule set. null/undefined clears it (back to the default).
export function normalizeSeedingRules(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Seeding rules must be an object');
  if (!SEEDING_PRIMARY.includes(input.primary)) throw new Error('Choose how pool records rank teams');
  const tiebreakers = Array.isArray(input.tiebreakers) ? input.tiebreakers : [];
  if (tiebreakers.some(key => !SEEDING_TIEBREAKERS.includes(key))) throw new Error('Unknown seeding tiebreaker');
  if (new Set(tiebreakers).size !== tiebreakers.length) throw new Error('Each tiebreaker can be used once');
  return { primary:input.primary, allowsTies:input.allowsTies !== false, tiebreakers:[...tiebreakers] };
}

export function isAstEvent(event, meta) {
  return event?.discovery?.provider === 'ast' || /allstartournaments\.com/i.test(event?.providerRef || '')
    || meta?.provider === 'ast' || !!meta?.ast;
}

// The rules the engine should use, tagged with where they came from, or null when unknown.
export function resolveSeedingRules(event, meta) {
  const saved = event?.config?.seedingRules;
  if (saved && SEEDING_PRIMARY.includes(saved.primary)) return { ...saved, verified:true, source:'admin' };
  if (isAstEvent(event, meta)) return { ...AST_DEFAULT_SEEDING_RULES, tiebreakers:[...AST_DEFAULT_SEEDING_RULES.tiebreakers], verified:true, source:'ast-default' };
  return null;
}

// Attach the resolved rules to a snapshot's meta without mutating the stored object.
export function withSeedingRules(snap, event) {
  if (!snap) return snap;
  const projectionRules = resolveSeedingRules(event, snap.meta);
  return { ...snap, meta:{ ...(snap.meta || {}), projectionRules } };
}
