// Pure age/skill-level parsing for division and team-class names, shared by every provider's
// discovery code. Replaces the old literal `startsWith(agePrefix)` check, which required an
// exact naming convention ("10O", "10B") and silently failed on anything else a provider might
// publish ("U10", "10-B/C", "10 & Under").
//
// An "age" is the number of years-and-under a division/team plays at (10U = 10-and-under).
// Division names sometimes carry TWO numbers that aren't ages (a combined "10/12U" division, or
// unrelated numbers like a pool "100" or "Field 10") — divisionAges() returns every number that
// is grammatically an age marker, so callers can require an exact single-age match rather than
// guessing from the first digit string found.

const AGE_TOKEN = /(\d{1,2})\s*U\b|\bU\s*(\d{1,2})\b/gi;               // "10U" | "U10"
const AGE_COMBO_TOKEN = /(\d{1,2})\s*\/\s*(\d{1,2})\s*U\b/gi;          // "10/12U" (both ages)
// "10B" / "10C" / "10O" (skill-letter suffix directly on the number, no separator)
const AGE_SKILL_TOKEN = /\b(\d{1,2})\s*[-\s]?\s*([BCO])\b/gi;
// "10-Open", "10 & Under", "10 and Under"
const AGE_WORD_TOKEN = /\b(\d{1,2})\s*(?:-|&|\band\b)?\s*(?:Open|Under)\b/gi;

// Returns every distinct age (as a Number) found in `name` via one of the recognized markers.
// A bare number with no marker ("100", "Pool 10", a date) is never an age. A combined division
// name ("10/12U") returns [10, 12] — callers that need one age should treat >1 result as
// ambiguous rather than picking the first.
export function divisionAges(name) {
  const s = String(name || '');
  const ages = new Set();
  const inRange = n => Number.isFinite(n) && n >= 4 && n <= 19; // youth softball/baseball age range
  AGE_COMBO_TOKEN.lastIndex = 0;
  let combo;
  while ((combo = AGE_COMBO_TOKEN.exec(s))) {
    [combo[1], combo[2]].map(Number).forEach(n => { if (inRange(n)) ages.add(n); });
  }
  for (const re of [AGE_TOKEN, AGE_SKILL_TOKEN, AGE_WORD_TOKEN]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const n = Number(m[1] ?? m[2]);
      if (inRange(n)) ages.add(n);
    }
  }
  return [...ages].sort((a, b) => a - b);
}

// ---- Team-name matching across providers ----
// Providers may format a team/coaching suffix differently: "Example Club - Coach", AST
// "Example Club-Coach", or the display name "Example Club". Compare case/punctuation-insensitively,
// ignoring a leading seed ("[3] ").
export const teamNameKey = value => String(value ?? '').replace(/^\s*\[\d+\]\s*/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// The team part of a "Team-Coach" roster entry: "Example Club - Coach" → "Example Club". Only a
// trailing letters-only suffix counts as a coach, so "… - 10U Black - Smith" keeps "… - 10U Black".
export const rosterTeamPart = value => String(value ?? '').replace(/^\s*\[\d+\]\s*/, '')
  .replace(/\s*[-–—]\s*[A-Za-z][A-Za-z.'’\/ ]*$/, '').trim();

// Finds our team among `items` by any of `names` (NorCal profile name, configured provider name,
// display name…). An exact name match wins; otherwise the team part of "Team-Coach" entries is
// compared, but only an unambiguous hit counts — two "Example Club-*" teams return null rather
// than guessing.
export function findTeamByName(items, names, nameOf = item => item) {
  const wanted = names.filter(Boolean);
  const exact = new Set(wanted.map(teamNameKey).filter(Boolean));
  if (!exact.size) return null;
  const exactHits = items.filter(item => exact.has(teamNameKey(nameOf(item))));
  if (exactHits.length) return exactHits.length === 1 || new Set(exactHits.map(nameOf)).size === 1 ? exactHits[0] : null;
  const parts = new Set(wanted.flatMap(name => [teamNameKey(name), teamNameKey(rosterTeamPart(name))]).filter(Boolean));
  const partHits = items.filter(item => parts.has(teamNameKey(rosterTeamPart(nameOf(item)))));
  return partHits.length === 1 ? partHits[0] : null;
}

// A configured/free-text age ("10", "10U", "10B", 10) as a Number, or null when unparseable.
// Team `agePrefix` is admin-entered text, so never compare it as a raw string.
export function parseAge(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = String(value ?? '').match(/\d{1,2}/);
  return m ? Number(m[0]) : null;
}

// True when `name` unambiguously names the given age (exactly one age marker, matching).
export function divisionMatchesAge(name, age) {
  const ages = divisionAges(name);
  return ages.length === 1 && ages[0] === parseAge(age);
}

// Skill letter from a division name carrying one directly ("10B" -> "B"), else null (a combined
// division has no letter of its own — skill comes from team-level data instead).
export function divisionLevel(name) {
  const m = String(name || '').match(/\b\d{1,2}\s*[-\s]?\s*([A-D])\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Age from a NorCal team-class string, e.g. "10-B" / "10B" / "10-Open" -> 10. Returns null when
// unparseable (NorCal's own `apex.age` field is unreliable — often null — so callers should use
// this against `info.teamClass`/`info.teamClassAbr` instead).
export function teamClassAge(teamClass) {
  const m = String(teamClass || '').match(/^(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

// Skill letter from a NorCal team-class string ("10-B" -> "B", "10-Open" -> "O").
export function teamClassLevel(teamClass) {
  const s = String(teamClass || '');
  if (/open/i.test(s)) return 'O';
  const m = s.match(/^\d{1,2}\s*[-\s]?\s*([A-D])/i);
  return m ? m[1].toUpperCase() : null;
}
