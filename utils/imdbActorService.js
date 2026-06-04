// backend/utils/imdbActorService.js
import {
  buildFallbackImdbVirtualMovie,
  buildVirtualMovieFromImdbId,
  normalizeImdbTitleId,
} from './imdbTitleService.js';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

const TIMEOUT_MS = Number(process.env.IMDB_ACTOR_TIMEOUT_MS || 8000);
const MAX_CREDIT_ROWS = Number(process.env.IMDB_ACTOR_MAX_CREDITS || 300);

const clean = (value = '') => String(value ?? '').trim();

const normalizeKey = (value = '') =>
  clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const fetchJsonWithTimeout = async (url, timeoutMs = TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MovieFrost Hindi/1.0 (https://hi.moviefrost.com)',
      },
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(data?.message || `HTTP ${res.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
};

const fetchWikidataApi = (params = {}) => {
  const url = new URL(WIKIDATA_API);

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  return fetchJsonWithTimeout(url.toString());
};

const fetchSparql = async (query) => {
  const url = new URL(WIKIDATA_SPARQL);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');

  const data = await fetchJsonWithTimeout(url.toString());
  return Array.isArray(data?.results?.bindings) ? data.results.bindings : [];
};

const bindingValue = (row, key) => clean(row?.[key]?.value);

const qidFromUri = (uri = '') => {
  const match = clean(uri).match(/\/(Q\d+)$/i);
  return match ? match[1] : '';
};

const isoDateOnly = (value = '') => {
  const raw = clean(value);
  if (!raw) return '';

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);

  return d.toISOString().slice(0, 10);
};

const yearFromDate = (value = '') => {
  const match = clean(value).match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : '';
};

const scorePersonCandidate = (candidate, targetName = '') => {
  const a = normalizeKey(candidate?.name);
  const b = normalizeKey(targetName);

  let score = 0;

  if (a && b) {
    if (a === b) score += 100;
    else if (a.includes(b) || b.includes(a)) score += 30;
  }

  if (candidate?.imdbId) score += 40;
  if (candidate?.image) score += 10;

  return score;
};

const searchPersonQids = async (name = '') => {
  const q = clean(name);
  if (!q) return [];

  const data = await fetchWikidataApi({
    action: 'wbsearchentities',
    search: q,
    language: 'en',
    type: 'item',
    limit: 8,
  });

  return (Array.isArray(data?.search) ? data.search : [])
    .map((item) => clean(item?.id))
    .filter((id) => /^Q\d+$/i.test(id));
};

const fetchProfilesByQids = async (qids = []) => {
  const ids = (Array.isArray(qids) ? qids : [])
    .map((id) => clean(id))
    .filter((id) => /^Q\d+$/i.test(id))
    .slice(0, 8);

  if (!ids.length) return [];

  const values = ids.map((id) => `wd:${id}`).join(' ');

  const query = `
SELECT ?person ?personLabel ?personDescription ?imdbId ?image ?birthDate ?deathDate ?placeOfBirthLabel WHERE {
  VALUES ?person { ${values} }
  ?person wdt:P31 wd:Q5.
  OPTIONAL { ?person wdt:P345 ?imdbId. }
  OPTIONAL { ?person wdt:P18 ?image. }
  OPTIONAL { ?person wdt:P569 ?birthDate. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P19 ?placeOfBirth. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

  const rows = await fetchSparql(query);

  return rows.map((row) => ({
    qid: qidFromUri(bindingValue(row, 'person')),
    name: bindingValue(row, 'personLabel'),
    description: bindingValue(row, 'personDescription'),
    imdbId: bindingValue(row, 'imdbId'),
    image: bindingValue(row, 'image'),
    birthday: isoDateOnly(bindingValue(row, 'birthDate')),
    deathday: isoDateOnly(bindingValue(row, 'deathDate')),
    placeOfBirth: bindingValue(row, 'placeOfBirthLabel'),
  }));
};

const fetchProfileByImdbId = async (imdbId = '') => {
  const nm = clean(imdbId);
  if (!/^nm\d{5,10}$/i.test(nm)) return null;

  const query = `
SELECT ?person ?personLabel ?personDescription ?imdbId ?image ?birthDate ?deathDate ?placeOfBirthLabel WHERE {
  ?person wdt:P345 "${nm}".
  ?person wdt:P31 wd:Q5.
  OPTIONAL { ?person wdt:P18 ?image. }
  OPTIONAL { ?person wdt:P569 ?birthDate. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P19 ?placeOfBirth. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 1
`;

  const rows = await fetchSparql(query);
  const row = rows[0];

  if (!row) return null;

  return {
    qid: qidFromUri(bindingValue(row, 'person')),
    name: bindingValue(row, 'personLabel'),
    description: bindingValue(row, 'personDescription'),
    imdbId: bindingValue(row, 'imdbId') || nm,
    image: bindingValue(row, 'image'),
    birthday: isoDateOnly(bindingValue(row, 'birthDate')),
    deathday: isoDateOnly(bindingValue(row, 'deathDate')),
    placeOfBirth: bindingValue(row, 'placeOfBirthLabel'),
  };
};

const resolvePersonProfile = async ({ name = '', imdbId = '' } = {}) => {
  const direct = await fetchProfileByImdbId(imdbId).catch(() => null);
  if (direct?.qid) return direct;

  const qids = await searchPersonQids(name).catch(() => []);
  const profiles = await fetchProfilesByQids(qids).catch(() => []);

  if (!profiles.length) return null;

  return profiles
    .map((profile) => ({
      profile,
      score: scorePersonCandidate(profile, name),
    }))
    .sort((a, b) => b.score - a.score)[0]?.profile || profiles[0];
};

const fetchCreditsByPersonQid = async (qid = '', roles = ['actor']) => {
  const safeQid = clean(qid);
  if (!/^Q\d+$/i.test(safeQid)) return [];

  const roleSet = new Set(
    (Array.isArray(roles) ? roles : [])
      .map((role) => clean(role).toLowerCase())
      .filter(Boolean)
  );

  const actorPart =
    roleSet.size === 0 || roleSet.has('actor')
      ? `{ ?work wdt:P161 wd:${safeQid}. BIND("actor" AS ?role) }`
      : '';

  const directorPart = roleSet.has('director')
    ? `{ ?work wdt:P57 wd:${safeQid}. BIND("director" AS ?role) }`
    : '';

  const creatorPart = roleSet.has('director')
    ? `{ ?work wdt:P170 wd:${safeQid}. BIND("creator" AS ?role) }`
    : '';

  const unionParts = [actorPart, directorPart, creatorPart].filter(Boolean);

  if (!unionParts.length) {
    unionParts.push(`{ ?work wdt:P161 wd:${safeQid}. BIND("actor" AS ?role) }`);
  }

  const query = `
SELECT ?work ?workLabel ?workDescription ?imdbId ?date ?image ?instanceLabel ?role WHERE {
  ${unionParts.join(' UNION ')}
  ?work wdt:P345 ?imdbId.
  OPTIONAL { ?work wdt:P577 ?date. }
  OPTIONAL { ?work wdt:P18 ?image. }
  OPTIONAL { ?work wdt:P31 ?instance. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${Math.max(20, Math.min(MAX_CREDIT_ROWS, 500))}
`;

  const rows = await fetchSparql(query);

  const seen = new Set();

  return rows
    .map((row) => {
      const imdbId = normalizeImdbTitleId(bindingValue(row, 'imdbId'));
      const title = bindingValue(row, 'workLabel');

      if (!imdbId || !title) return null;

      const key = imdbId;
      if (seen.has(key)) return null;
      seen.add(key);

      const instanceLabel = bindingValue(row, 'instanceLabel');
      const instanceKey = normalizeKey(instanceLabel);

      const type =
        instanceKey.includes('television') ||
          instanceKey.includes('series') ||
          instanceKey.includes('serial')
          ? 'WebSeries'
          : 'Movie';

      return {
        imdbId,
        title,
        desc: bindingValue(row, 'workDescription'),
        year: yearFromDate(bindingValue(row, 'date')),
        image: bindingValue(row, 'image'),
        type,
        role: bindingValue(row, 'role'),
        date: bindingValue(row, 'date'),
      };
    })
    .filter(Boolean);
};

const sortCreditRows = (rows = [], sort = 'latest') => {
  const list = Array.isArray(rows) ? [...rows] : [];

  // IMDb/Wikidata does not provide reliable free popularity.
  // Keep best/popular deterministic and professional by using newer known works first.
  return list.sort((a, b) => {
    const ay = Number(a?.year || 0);
    const by = Number(b?.year || 0);
    if (by !== ay) return by - ay;
    return clean(a?.title).localeCompare(clean(b?.title));
  });
};

const rowToFallback = (row = {}) => ({
  imdbId: row.imdbId,
  title: row.title,
  year: row.year,
  poster: row.image,
  desc: row.desc,
  type: row.type,
});

const mapCreditRowToVirtual = async (row = {}) => {
  const fallback = rowToFallback(row);

  const movie = await buildVirtualMovieFromImdbId(row.imdbId, fallback);
  if (movie) return movie;

  return buildFallbackImdbVirtualMovie(fallback);
};

export const fetchImdbActorProfileAndCredits = async ({
  name = '',
  actorImdbId = '',
  roles = ['actor'],
  page = 1,
  limit = 20,
  sort = 'latest',
} = {}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 40);

  const profile = await resolvePersonProfile({
    name,
    imdbId: actorImdbId,
  }).catch(() => null);

  if (!profile?.qid) {
    return {
      enabled: true,
      found: false,
      profile: null,
      results: [],
      page: safePage,
      pages: 0,
      totalResults: 0,
      reason: 'person_not_found',
    };
  }

  const rows = await fetchCreditsByPersonQid(profile.qid, roles).catch(() => []);
  const sorted = sortCreditRows(rows, sort);

  const totalResults = sorted.length;
  const pages = totalResults ? Math.ceil(totalResults / safeLimit) : 0;
  const start = (safePage - 1) * safeLimit;

  const slice = sorted.slice(start, start + safeLimit);

  const results = (
    await Promise.all(slice.map((row) => mapCreditRowToVirtual(row)))
  ).filter(Boolean);

  return {
    enabled: true,
    found: true,
    profile,
    results,
    page: safePage,
    pages,
    totalResults,
    reason: 'ok',
  };
};

export default {
  fetchImdbActorProfileAndCredits,
};
