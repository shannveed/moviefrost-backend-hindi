// backend/Controllers/ImdbSearchController.js
import asyncHandler from 'express-async-handler';

import Movie from '../Models/MoviesModel.js';
import { escapeRegex, slugify } from '../utils/slugify.js';
import {
  normalizeImdbSearchType,
  normalizeImdbTitleId,
  searchImdbTitles,
} from '../utils/imdbTitleService.js';

const publicVisibilityFilter = { isPublished: { $ne: false } };
const SEARCH_LIMIT_MAX = 20;

const PUBLIC_SEARCH_SELECT =
  '_id slug name image titleImage thumbnailInfo type category browseBy time year language latest previousHit latestNew banner isPublished orderIndex rate numberOfReviews imdbId viewCount createdAt updatedAt';

const clean = (value = '') => String(value ?? '').trim();

const clampPage = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.floor(n);
};

const clampLimit = (value, fallback = 10) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), SEARCH_LIMIT_MAX);
};

const normalizeTypeParam = (value = '') => {
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

  return null;
};

const splitCsv = (value = '') =>
  clean(value)
    .split(',')
    .map((item) => clean(item))
    .filter(Boolean);

const hasAdvancedFilters = (query = {}) =>
  [
    query.category,
    query.browseBy,
    query.language,
    query.year,
    query.time,
    query.rate,
  ].some((value) => clean(value));

const numberOrText = (value) => {
  const raw = clean(value);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
};

const buildLocalFilter = ({ queryText = '', query = {} } = {}) => {
  const re = new RegExp(escapeRegex(queryText), 'i');
  const type = normalizeTypeParam(query.type);
  const browseByList = splitCsv(query.browseBy);

  return {
    ...publicVisibilityFilter,
    ...(type ? { type } : {}),

    ...(clean(query.category) ? { category: clean(query.category) } : {}),
    ...(clean(query.language) ? { language: clean(query.language) } : {}),
    ...(clean(query.year) ? { year: numberOrText(query.year) } : {}),
    ...(clean(query.time) ? { time: numberOrText(query.time) } : {}),
    ...(clean(query.rate) ? { rate: numberOrText(query.rate) } : {}),
    ...(browseByList.length ? { browseBy: { $in: browseByList } } : {}),

    $or: [
      { name: re },
      { category: re },
      { browseBy: re },
      { language: re },
      { thumbnailInfo: re },
      { imdbId: re },
    ],
  };
};

const shapeLocalMovie = (movie = {}) => {
  const seg = movie?.slug || movie?._id;

  return {
    ...movie,
    source: 'local',
    isImdbVirtual: false,
    href: seg ? `/movie/${seg}` : '',
    watchHref: seg ? `/watch/${seg}` : '',
  };
};

const titleYearKey = (item = {}) => {
  const title = clean(item?.name || item?.title);
  const year = Number(item?.year);

  const titleSlug = slugify(title);
  if (!titleSlug) return '';

  return `${titleSlug}:${Number.isFinite(year) ? year : ''}`;
};

const imdbKey = (item = {}) => {
  const id = normalizeImdbTitleId(item?.imdbId);
  return id ? `imdb:${id}` : '';
};

const buildLocalMatchQuery = (items = []) => {
  const or = [];

  for (const item of items || []) {
    const imdbId = normalizeImdbTitleId(item?.imdbId);
    if (imdbId) {
      or.push({ imdbId });
    }

    const name = clean(item?.name);
    if (name) {
      const namePrefix = new RegExp(`^\\s*${escapeRegex(name)}`, 'i');
      const year = Number(item?.year);

      if (Number.isFinite(year) && year > 1800) {
        or.push({ name: namePrefix, year });
      } else {
        or.push({ name: namePrefix });
      }
    }
  }

  return or;
};

const replaceVirtualsWithLocalMatches = async (items = []) => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return [];

  const or = buildLocalMatchQuery(list);
  if (!or.length) return list;

  const localDocs = await Movie.find({
    ...publicVisibilityFilter,
    $or: or,
  })
    .sort({ latest: -1, latestNewAt: -1, orderIndex: 1, createdAt: -1 })
    .limit(200)
    .select(PUBLIC_SEARCH_SELECT)
    .lean();

  const imdbMap = new Map();
  const titleMap = new Map();

  for (const doc of localDocs || []) {
    const shaped = shapeLocalMovie(doc);

    const iKey = imdbKey(shaped);
    if (iKey && !imdbMap.has(iKey)) imdbMap.set(iKey, shaped);

    const tKey = titleYearKey(shaped);
    if (tKey && !titleMap.has(tKey)) titleMap.set(tKey, shaped);
  }

  return list.map((item) => {
    const iKey = imdbKey(item);
    if (iKey && imdbMap.has(iKey)) return imdbMap.get(iKey);

    const tKey = titleYearKey(item);
    if (tKey && titleMap.has(tKey)) return titleMap.get(tKey);

    return item;
  });
};

const getLocalSearchPage = async ({ queryText, query, page, limit }) => {
  const filter = buildLocalFilter({ queryText, query });
  const skip = (page - 1) * limit;

  const lowerTerm = queryText.toLowerCase();

  const [rows, total] = await Promise.all([
    Movie.aggregate([
      { $match: filter },
      {
        $addFields: {
          __nameLower: { $toLower: { $ifNull: ['$name', ''] } },
        },
      },
      {
        $addFields: {
          __score: {
            $switch: {
              branches: [
                { case: { $eq: ['$__nameLower', lowerTerm] }, then: 100 },
                {
                  case: {
                    $regexMatch: {
                      input: '$__nameLower',
                      regex: new RegExp(`^${escapeRegex(lowerTerm)}`),
                    },
                  },
                  then: 80,
                },
                {
                  case: {
                    $regexMatch: {
                      input: '$__nameLower',
                      regex: new RegExp(escapeRegex(lowerTerm)),
                    },
                  },
                  then: 60,
                },
              ],
              default: 10,
            },
          },
        },
      },
      {
        $sort: {
          __score: -1,
          latest: -1,
          latestNewAt: -1,
          orderIndex: 1,
          createdAt: -1,
        },
      },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          slug: 1,
          name: 1,
          image: 1,
          titleImage: 1,
          thumbnailInfo: 1,
          type: 1,
          category: 1,
          browseBy: 1,
          time: 1,
          year: 1,
          language: 1,
          latest: 1,
          previousHit: 1,
          latestNew: 1,
          banner: 1,
          isPublished: 1,
          orderIndex: 1,
          rate: 1,
          numberOfReviews: 1,
          imdbId: 1,
          viewCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ]),

    Movie.countDocuments(filter),
  ]);

  return {
    movies: (rows || []).map(shapeLocalMovie),
    total,
  };
};

/**
 * PUBLIC
 *
 * /api/movies?search=...
 * Local Mongo first, IMDb/OMDb fallback second.
 */
export const searchMoviesAndImdb = asyncHandler(async (req, res) => {
  const queryText = clean(req.query.search || req.query.query || req.query.q);

  if (!queryText) {
    res.status(400);
    throw new Error('Search query is required');
  }

  const page = clampPage(req.query.pageNumber || req.query.page || 1);
  const limit = clampLimit(req.query.limit, 10);

  const { movies: localMovies, total: localTotal } = await getLocalSearchPage({
    queryText,
    query: req.query || {},
    page,
    limit,
  });

  const localPages = Math.ceil(Number(localTotal || 0) / limit) || 1;

  if (localTotal > 0 || hasAdvancedFilters(req.query || {})) {
    return res
      .set(
        'Cache-Control',
        'public, max-age=60, s-maxage=60, stale-while-revalidate=600'
      )
      .json({
        movies: localMovies,
        page,
        pages: localPages,
        totalMovies: localTotal,
        search: queryText,
        source: 'local',
        imdbFallback: false,
        localTotalMovies: localTotal,
      });
  }

  const imdbResult = await searchImdbTitles({
    query: queryText,
    type: normalizeImdbSearchType(req.query.type),
    page,
    limit,
  });

  const movies = await replaceVirtualsWithLocalMatches(imdbResult?.results || []);

  return res
    .set(
      'Cache-Control',
      'public, max-age=120, s-maxage=120, stale-while-revalidate=900'
    )
    .json({
      movies,
      page: Number(imdbResult?.page || page),
      pages: Math.max(1, Number(imdbResult?.pages || 1)),
      totalMovies: Number(imdbResult?.totalResults || movies.length || 0),
      search: queryText,
      source: 'imdb',
      imdbFallback: true,
      localTotalMovies: 0,
      imdbEnabled: !!imdbResult?.enabled,
      imdbReason: imdbResult?.reason || 'ok',
    });
});

export default {
  searchMoviesAndImdb,
};
