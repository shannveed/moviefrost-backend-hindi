// backend/utils/imdbTitleService.js
import dotenv from 'dotenv';
dotenv.config();

import { slugify } from './slugify.js';

const OMDB_API_KEY = String(process.env.OMDB_API_KEY || '').trim();
const OMDB_BASE = 'https://www.omdbapi.com/';

const TIMEOUT_MS = Number(process.env.IMDB_OMDB_TIMEOUT_MS || 6500);
const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_LIMIT = 20;

const DEFAULT_POSTER = '/images/MOVIEFROST.png';

const PLAYER_BASE = String(
  process.env.IMDB_VIRTUAL_PLAYER_BASE || 'https://kwita408ant.com//play'
).replace(/\/+$/, '');

const clean = (value = '') => String(value ?? '').trim();

export const isImdbTitleServiceEnabled = () => !!OMDB_API_KEY;

export const normalizeImdbTitleId = (value = '') => {
  const match = String(value || '').match(/tt\d{5,10}/i);
  return match ? match[0].toLowerCase() : '';
};

const fetchJsonWithTimeout = async (url, timeoutMs = TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MovieFrost/1.0',
      },
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(data?.Error || data?.message || `HTTP ${res.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
};

const buildOmdbUrl = (params = {}) => {
  const p = new URLSearchParams();
  p.set('apikey', OMDB_API_KEY);

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    p.set(key, String(value));
  });

  return `${OMDB_BASE}?${p.toString()}`;
};

const parseYear = (value = '') => {
  const match = String(value || '').match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : '';
};

const parseRuntimeMinutes = (value = '') => {
  const match = String(value || '').match(/(\d+)\s*min/i);
  const n = match ? Number(match[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 120;
};

const toNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '' || value === 'N/A') {
    return null;
  }

  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const parseRottenTomatoesRating = (ratings = []) => {
  const list = Array.isArray(ratings) ? ratings : [];

  const rt = list.find(
    (item) => clean(item?.Source).toLowerCase() === 'rotten tomatoes'
  );

  if (!rt?.Value || rt.Value === 'N/A') return null;

  const n = Number(String(rt.Value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
};

const omdbTypeToLocalType = (value = '') => {
  const type = clean(value).toLowerCase();
  if (type === 'series' || type === 'episode') return 'WebSeries';
  return 'Movie';
};

const localTypeToOmdbType = (value = '') => {
  const raw = clean(value).toLowerCase();

  if (
    raw === 'webseries' ||
    raw === 'web-series' ||
    raw === 'web series' ||
    raw === 'tvshows' ||
    raw === 'tv-shows' ||
    raw === 'tv shows' ||
    raw === 'series'
  ) {
    return 'series';
  }

  if (raw === 'movie' || raw === 'movies') return 'movie';

  return '';
};

const buildPlayUrl = (imdbId = '') => {
  const safe = normalizeImdbTitleId(imdbId);
  return safe ? `${PLAYER_BASE}/${safe}` : '';
};

const posterUrl = (value = '') => {
  const url = clean(value);
  if (!url || url === 'N/A') return '';
  return url;
};

const splitNames = (value = '') =>
  clean(value)
    .split(',')
    .map((item) => clean(item))
    .filter(Boolean);

const buildCastPlaceholders = (actors = '') =>
  splitNames(actors)
    .slice(0, 12)
    .map((name) => ({
      name,
      image: '/images/placeholder.jpg',
      slug: slugify(name),
      imdbId: '',
    }));

export const buildFallbackImdbVirtualMovie = ({
  imdbId,
  title = '',
  year = '',
  type = 'Movie',
  poster = '',
  desc = '',
  category = '',
  language = '',
} = {}) => {
  const safeId = normalizeImdbTitleId(imdbId);
  if (!safeId) return null;

  const name = clean(title) || safeId;
  const y = parseYear(year);
  const slug = `imdb/${safeId}`;
  const playUrl = buildPlayUrl(safeId);
  const localType = type === 'WebSeries' ? 'WebSeries' : 'Movie';

  const base = {
    _id: `imdb-${safeId}`,
    source: 'imdb',
    isImdbVirtual: true,

    imdbId: safeId,
    tmdbId: null,
    tmdbType: '',

    type: localType,
    name,
    slug,

    href: `/movie/imdb/${safeId}`,
    watchHref: `/watch/imdb/${safeId}`,

    image: posterUrl(poster) || DEFAULT_POSTER,
    titleImage: posterUrl(poster) || DEFAULT_POSTER,

    desc: clean(desc) || `${name} on MovieFrost.`,
    category: clean(category) || 'Drama',
    browseBy:
      localType === 'WebSeries'
        ? 'IMDb Web Series'
        : 'IMDb Movie',

    thumbnailInfo: '',

    language: clean(language) || 'English',
    year: y || '',
    time: localType === 'WebSeries' ? 45 : 120,

    rate: 0,
    numberOfReviews: 0,
    viewCount: 0,

    casts: [],
    director: '',

    trailerUrl: '',
    faqs: [],

    seoTitle: name,
    seoDescription: clean(desc).substring(0, 300) || `${name} on MovieFrost.`,
    seoKeywords: `${name}, IMDb, MovieFrost`,

    latest: false,
    previousHit: false,
    latestNew: false,
    banner: false,
    isPublished: true,

    externalRatings: {
      imdb: {
        rating: null,
        votes: null,
        url: `https://www.imdb.com/title/${safeId}/`,
      },
      rottenTomatoes: {
        rating: null,
        url: name
          ? `https://www.rottentomatoes.com/search?search=${encodeURIComponent(
            name
          )}`
          : '',
      },
    },
  };

  return {
    ...base,
    videoUrl7: playUrl,
    video: playUrl,
    videoUrl2: playUrl,
    videoUrl3: playUrl,
    downloadUrl: '',
    episodes: localType === 'WebSeries' ? [] : undefined,
  };
};

export const mapOmdbDetailsToVirtualMovie = (data = {}, fallback = {}) => {
  const imdbId = normalizeImdbTitleId(data?.imdbID || fallback?.imdbId);
  if (!imdbId) return buildFallbackImdbVirtualMovie(fallback);

  const type = omdbTypeToLocalType(data?.Type || fallback?.type);
  const name = clean(data?.Title || fallback?.title || imdbId);
  const year = parseYear(data?.Year || fallback?.year);
  const poster = posterUrl(data?.Poster) || posterUrl(fallback?.poster);
  const desc = clean(data?.Plot && data.Plot !== 'N/A' ? data.Plot : fallback?.desc);

  const imdbRating = toNumberOrNull(data?.imdbRating);
  const imdbVotes = toNumberOrNull(data?.imdbVotes);
  const rottenRating = parseRottenTomatoesRating(data?.Ratings);

  const playUrl = buildPlayUrl(imdbId);
  const slug = `imdb/${imdbId}`;

  const base = {
    _id: `imdb-${imdbId}`,
    source: 'imdb',
    isImdbVirtual: true,

    imdbId,
    tmdbId: null,
    tmdbType: '',

    type,
    name,
    slug,

    href: `/movie/imdb/${imdbId}`,
    watchHref: `/watch/imdb/${imdbId}`,

    image: poster || DEFAULT_POSTER,
    titleImage: poster || DEFAULT_POSTER,

    desc: desc || `${name} on MovieFrost.`,
    category:
      data?.Genre && data.Genre !== 'N/A'
        ? clean(data.Genre)
        : clean(fallback?.category) || 'Drama',

    browseBy: type === 'WebSeries' ? 'IMDb Web Series' : 'IMDb Movie',

    thumbnailInfo: '',

    language:
      data?.Language && data.Language !== 'N/A'
        ? clean(data.Language).split(',')[0].trim()
        : clean(fallback?.language) || 'English',

    year: year || '',
    time: parseRuntimeMinutes(data?.Runtime),

    rate: imdbRating ? Math.round((imdbRating / 2) * 10) / 10 : 0,
    numberOfReviews: imdbVotes || 0,
    viewCount: 0,

    casts: buildCastPlaceholders(data?.Actors),
    director:
      data?.Director && data.Director !== 'N/A' ? clean(data.Director) : '',

    trailerUrl: '',
    faqs: [],

    seoTitle: name,
    seoDescription: (desc || `${name} on MovieFrost.`).substring(0, 300),
    seoKeywords: `${name}, IMDb, ${data?.Genre || ''}`,

    latest: false,
    previousHit: false,
    latestNew: false,
    banner: false,
    isPublished: true,

    externalRatings: {
      imdb: {
        rating: imdbRating,
        votes: imdbVotes,
        url: `https://www.imdb.com/title/${imdbId}/`,
      },
      rottenTomatoes: {
        rating: rottenRating,
        url: name
          ? `https://www.rottentomatoes.com/search?search=${encodeURIComponent(
            name
          )}`
          : '',
      },
    },
  };

  return {
    ...base,
    videoUrl7: playUrl,
    video: playUrl,
    videoUrl2: playUrl,
    videoUrl3: playUrl,
    downloadUrl: '',
    episodes: type === 'WebSeries' ? [] : undefined,
  };
};

export const fetchOmdbTitleByImdbId = async (imdbId) => {
  const safeId = normalizeImdbTitleId(imdbId);
  if (!safeId || !OMDB_API_KEY) return null;

  const data = await fetchJsonWithTimeout(
    buildOmdbUrl({
      i: safeId,
      plot: 'full',
      tomatoes: 'true',
    })
  );

  if (!data || data.Response === 'False') return null;
  return data;
};

export const buildVirtualMovieFromImdbId = async (imdbId, fallback = {}) => {
  const safeId = normalizeImdbTitleId(imdbId);
  if (!safeId) return null;

  try {
    const data = await fetchOmdbTitleByImdbId(safeId);
    if (data) return mapOmdbDetailsToVirtualMovie(data, { ...fallback, imdbId: safeId });
  } catch {
    // fallback below
  }

  return buildFallbackImdbVirtualMovie({ ...fallback, imdbId: safeId });
};

const mapOmdbSearchRowToFallback = (row = {}) => ({
  imdbId: row?.imdbID,
  title: row?.Title,
  year: row?.Year,
  poster: row?.Poster,
  type: omdbTypeToLocalType(row?.Type),
});

export const searchImdbTitles = async ({
  query = '',
  type = '',
  page = 1,
  limit = 10,
} = {}) => {
  const q = clean(query);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(
    Math.max(1, Number(limit) || 10),
    MAX_SEARCH_LIMIT
  );

  if (!q || !OMDB_API_KEY) {
    return {
      enabled: !!OMDB_API_KEY,
      results: [],
      page: safePage,
      pages: 1,
      totalResults: 0,
      reason: !OMDB_API_KEY ? 'missing_omdb_key' : 'missing_query',
    };
  }

  const omdbType = localTypeToOmdbType(type);

  const pagesToFetch = Math.ceil(safeLimit / SEARCH_PAGE_SIZE);
  const allRows = [];
  let totalResults = 0;

  for (let i = 0; i < pagesToFetch; i += 1) {
    const omdbPage = safePage + i;

    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchJsonWithTimeout(
        buildOmdbUrl({
          s: q,
          type: omdbType || undefined,
          page: omdbPage,
        })
      );

      if (!data || data.Response === 'False') continue;

      const rows = Array.isArray(data.Search) ? data.Search : [];
      allRows.push(...rows);

      const total = Number(data.totalResults || 0);
      if (Number.isFinite(total) && total > totalResults) {
        totalResults = total;
      }
    } catch {
      // continue
    }
  }

  const seen = new Set();
  const limited = allRows
    .filter((row) => {
      const id = normalizeImdbTitleId(row?.imdbID);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, safeLimit);

  const results = await Promise.all(
    limited.map(async (row) =>
      buildVirtualMovieFromImdbId(row.imdbID, mapOmdbSearchRowToFallback(row))
    )
  );

  return {
    enabled: true,
    results: results.filter(Boolean),
    page: safePage,
    pages: Math.max(1, Math.ceil(totalResults / SEARCH_PAGE_SIZE) || 1),
    totalResults: totalResults || results.length,
    reason: 'ok',
  };
};

export const normalizeImdbSearchType = (value = '') => {
  const raw = clean(value).toLowerCase();

  if (raw === 'movie' || raw === 'movies') return 'Movie';

  if (
    raw === 'webseries' ||
    raw === 'web-series' ||
    raw === 'web series' ||
    raw === 'tvshows' ||
    raw === 'tv-shows' ||
    raw === 'tv shows' ||
    raw === 'series'
  ) {
    return 'WebSeries';
  }

  return '';
};

export default {
  isImdbTitleServiceEnabled,
  normalizeImdbTitleId,
  buildVirtualMovieFromImdbId,
  searchImdbTitles,
  normalizeImdbSearchType,
};
