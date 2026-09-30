const API = 'https://api.team-manager.gc.com/search?start_at_page=0&search_source=search';
const agePattern = /\b(?:\d{1,2}\s*[uabc]|u\s*\d{1,2})\b/gi;
const compact = value => String(value || '').toLowerCase().replace(agePattern, '').replace(/[^a-z0-9]/g, '');
const withoutAge = value => String(value || '').replace(agePattern, '').replace(/\s+/g, ' ').trim();

export function gameChangerNameParts(name) {
  const text = String(name || '').trim();
  const match = /^(.*?)\s*[-–—]\s*([^–—]+)$/.exec(text);
  return { team:(match?.[1] || text).trim(), coach:(match?.[2] || '').trim() };
}

export function gameChangerSearchTerms(name) {
  const { team } = gameChangerNameParts(name);
  const words = withoutAge(team).split(/\s+/).filter(Boolean);
  const terms = [team];
  for (let count = 1; count <= 2 && count < words.length; count++) {
    const shorter = words.slice(count).join(' ');
    if (shorter.length >= 4) terms.push(shorter);
  }
  return [...new Set(terms.filter(Boolean))];
}

export function gameChangerSeason(date) {
  const month = Number(String(date || '').slice(5, 7));
  if (!month) return null;
  return month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'fall';
}

export function gameChangerCandidates(hits, { name, age, date, state = 'CA' } = {}) {
  const expectedParts = gameChangerNameParts(name);
  const expected = compact(expectedParts.team);
  const expectedCoach = compact(expectedParts.coach);
  const expectedCores = gameChangerSearchTerms(name).map(compact).filter(Boolean);
  const expectedAge = String(age || name || '').match(/\b(\d{1,2})\s*[uabc]\b/i)?.[1]
    || String(age || '').match(/\d{1,2}/)?.[0];
  const expectedYear = Number(String(date || '').slice(0, 4));
  const expectedSeason = gameChangerSeason(date);
  return (hits || []).filter(hit => hit.type === 'team' && hit.result?.public_id)
    .map(({ result }) => {
      const id = String(result.public_id);
      if (!/^[\w-]+$/.test(id)) return null;
      const label = String(result.name || '');
      const parts = gameChangerNameParts(label);
      const normalized = compact(parts.team);
      const foundAge = label.match(/\b(\d{1,2})\s*[uabc]\b/i)?.[1];
      const season = String(result.season?.name || '').toLowerCase();
      const year = Number(result.season?.year || 0);
      const exactName = !!expected && normalized === expected;
      const coreMatch = expectedCores.some(core => normalized === core || normalized.endsWith(core) || normalized.startsWith(core));
      const city = String(result.location?.city || '');
      const cityMatch = !!city && compact(expectedParts.team).startsWith(compact(city));
      const staff = Array.isArray(result.staff) ? result.staff.map(person => typeof person === 'string'
        ? person : [person?.name, person?.first_name, person?.last_name].filter(Boolean).join(' ')) : [];
      const coachMatch = !!expectedCoach && compact([label, ...staff].join(' ')).includes(expectedCoach);
      const matchingPrefix = expectedCores.find(core => normalized.startsWith(core));
      const extraName = matchingPrefix ? normalized.slice(matchingPrefix.length) : '';
      const coachConflict = !!expectedCoach && ((!!parts.coach && compact(parts.coach) !== expectedCoach)
        || (!!extraName && !extraName.includes(expectedCoach)));
      const ageMatch = !expectedAge || foundAge === expectedAge;
      const seasonMatch = !!expectedSeason && !!expectedYear && season === expectedSeason && year === expectedYear;
      const stateMatch = !state || !result.location?.state
        || [state.toUpperCase(), state === 'CA' ? 'CALIFORNIA' : ''].includes(String(result.location.state).toUpperCase());
      const autoMatch = coreMatch && ageMatch && seasonMatch && stateMatch && !coachConflict
        && (exactName || cityMatch || coachMatch)
        && (exactName || !city || cityMatch);
      return { name:label, url:`https://web.gc.com/teams/${id}`,
        city, state:String(result.location?.state || ''),
        season:result.season?.name || '', year:year || null,
        exactName, cityMatch, coachMatch, ageMatch, seasonMatch, autoMatch,
        score:Number(exactName)*20 + Number(coreMatch)*10 + Number(coachMatch)*8
          + Number(cityMatch)*5 + Number(ageMatch)*3 + Number(seasonMatch)*2 - Number(coachConflict)*12 };
    }).filter(Boolean)
    .sort((a, b) => Number(b.autoMatch) - Number(a.autoMatch) || b.score - a.score || a.name.localeCompare(b.name))
    .map(({ score, ...candidate }) => candidate);
}

export async function searchGameChangerTeams(name, options = {}, fetchImpl = fetch) {
  const token = String(options.token || process.env.GAMECHANGER_TOKEN || '').trim();
  if (!token) throw new Error('Enter a GameChanger token in the admin page or configure GAMECHANGER_TOKEN');
  const season = gameChangerSeason(options.date);
  const year = Number(String(options.date || '').slice(0, 4));
  const filters = { sport:'softball', include_older_seasons:false,
    states:[options.state || 'CA'], types:['team'] };
  if (season && year) filters.seasons = [{ name:season, year }];
  const search = async term => {
    const response = await fetchImpl(API, { method:'POST', headers:{
      'gc-token':token, 'gc-app-name':'web',
      'Content-Type':'application/vnd.gc.com.post_search+json; version=0.0.0',
      'Accept':'application/vnd.gc.com.search_results+json; version=0.0.0',
    }, body:JSON.stringify({ name:term, ...filters }), signal:AbortSignal.timeout(10000) });
    if (!response.ok) {
      if (response.status === 401) throw new Error('GameChanger token expired or invalid');
      const body = await response.json().catch(() => ({}));
      const detail = String(body.message || body.error || '').replaceAll(token, '[redacted]').slice(0, 200);
      throw new Error(`GameChanger search failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()).hits || [];
  };
  const terms = gameChangerSearchTerms(name);
  const firstHits = await search(terms[0]);
  const hits = firstHits.length ? firstHits : (await Promise.all(terms.slice(1).map(search))).flat();
  const unique = [...new Map(hits.map(hit => [hit.result?.public_id, hit])).values()];
  return gameChangerCandidates(unique, { name, age:options.age, date:options.date, state:filters.states[0] });
}
