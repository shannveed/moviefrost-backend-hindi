// backend/Controllers/ActorsController.js
import asyncHandler from 'express-async-handler';

import Movie from '../Models/MoviesModel.js';
import { slugify, escapeRegex } from '../utils/slugify.js';
import { fetchImdbActorProfileAndCredits } from '../utils/imdbActorService.js';
import { normalizeImdbTitleId } from '../utils/imdbTitleService.js';

const publicVisibilityFilter = { isPublished: { $ne: false } };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;
const SITEMAP_LIMIT = 50000;

const SORT_VALUES = new Set(['latest', 'best', 'popular']);

const MOVIE_CARD_SELECT =
  '_id slug name image titleImage thumbnailInfo type category browseBy time year language rate numberOfReviews isPublished latest latestNew banner orderIndex createdAt updatedAt imdbId viewCount';

const clean = (value = '') => String(value ?? '').trim();

const clampLimit = (value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

const normalizeSort = (value = '') => {
  const raw = clean(value).toLowerCase();
  return SORT_VALUES.has(raw) ? raw : 'latest';
};

const titleCaseFromSlug = (slug = '') =>
  clean(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');

const castMatchesSlug = (cast, targetSlug) => {
  const storedSlug = clean(cast?.slug);
  if (storedSlug && storedSlug === targetSlug) return true;

  const nameSlug = slugify(cast?.name || '');
  return !!nameSlug && nameSlug === targetSlug;
};

const directorMatchesSlug = (movie, targetSlug) => {
  const storedSlug = clean(movie?.directorSlug);
  if (storedSlug && storedSlug === targetSlug) return true;

  const nameSlug = slugify(movie?.director || '');
  return !!nameSlug && nameSlug === targetSlug;
};

const buildActorMovieFilter = (slug) => {
  const looseName = titleCaseFromSlug(slug);
  const nameRegex = looseName
    ? new RegExp(`^${escapeRegex(looseName)}$`, 'i')
    : null;

  const or = [{ 'casts.slug': slug }, { directorSlug: slug }];

  if (nameRegex) {
    or.push({ 'casts.name': nameRegex });
    or.push({ director: nameRegex });
  }

  return {
    ...publicVisibilityFilter,
    $or: or,
  };
};

const extractLocalIdentity = ({ slug, docs = [] }) => {
  const roles = new Set();
  let name = '';
  let localImage = '';
  let actorImdbId = '';

  for (const movie of docs || []) {
    if (Array.isArray(movie?.casts)) {
      for (const cast of movie.casts) {
        if (!castMatchesSlug(cast, slug)) continue;

        roles.add('actor');

        if (!name && clean(cast?.name)) name = clean(cast.name);
        if (!localImage && clean(cast?.image)) localImage = clean(cast.image);

        const maybeImdbId = clean(cast?.imdbId);
        if (!actorImdbId && /^nm\d{5,10}$/i.test(maybeImdbId)) {
          actorImdbId = maybeImdbId;
        }
      }
    }

    if (directorMatchesSlug(movie, slug)) {
      roles.add('director');
      if (!name && clean(movie?.director)) name = clean(movie.director);
    }
  }

  return {
    name: name || titleCaseFromSlug(slug),
    localImage,
    roles: Array.from(roles),
    actorImdbId,
  };
};

const buildRoleLabel = (roles = []) => {
  const set = new Set(roles || []);
  if (set.has('actor') && set.has('director')) return 'Actor & Director';
  if (set.has('director')) return 'Director';
  return 'Actor';
};

const localSort = (sort = 'latest') => {
  if (sort === 'best') {
    return { rate: -1, numberOfReviews: -1, year: -1, createdAt: -1 };
  }

  if (sort === 'popular') {
    return { viewCount: -1, latestNewAt: -1, createdAt: -1 };
  }

  return { year: -1, latest: -1, orderIndex: 1, createdAt: -1 };
};

const titleYearKey = (item = {}) => {
  const title = clean(item?.name || item?.title);
  const year = Number(item?.year);
  const titleSlug = slugify(title);

  if (!titleSlug) return '';

  return `${titleSlug}:${Number.isFinite(year) ? year : ''}`;
};

const imdbKey = (item = {}) => {
  const imdbId = normalizeImdbTitleId(item?.imdbId);
  return imdbId ? `imdb:${imdbId}` : '';
};

const shapeLocalMovieCard = (movie) => {
  const seg = movie?.slug || movie?._id;

  return {
    ...movie,
    source: 'local',
    isImdbVirtual: false,
    href: seg ? `/movie/${seg}` : '',
    watchHref: seg ? `/watch/${seg}` : '',
  };
};

const buildLocalMaps = (docs = []) => {
  const imdb = new Map();
  const titleYear = new Map();

  for (const doc of docs || []) {
    const shaped = shapeLocalMovieCard(doc);

    const iKey = imdbKey(shaped);
    if (iKey && !imdb.has(iKey)) imdb.set(iKey, shaped);

    const tKey = titleYearKey(shaped);
    if (tKey && !titleYear.has(tKey)) titleYear.set(tKey, shaped);
  }

  return { imdb, titleYear };
};

const findLocalMatch = (virtual, maps) => {
  const iKey = imdbKey(virtual);
  if (iKey && maps.imdb.has(iKey)) return maps.imdb.get(iKey);

  const tKey = titleYearKey(virtual);
  if (tKey && maps.titleYear.has(tKey)) return maps.titleYear.get(tKey);

  return null;
};

const itemLatestValue = (item) => {
  const d = Date.parse(item?.updatedAt || item?.createdAt || '') || 0;
  if (d) return d;

  const y = Number(item?.year);
  return Number.isFinite(y) ? Date.UTC(y, 0, 1) : 0;
};

const sortMergedItems = (items = [], sort = 'latest') => {
  const list = Array.isArray(items) ? [...items] : [];

  if (sort === 'best') {
    return list.sort((a, b) => {
      const ar = Number(a?.rate || 0);
      const br = Number(b?.rate || 0);
      if (br !== ar) return br - ar;

      return Number(b?.numberOfReviews || 0) - Number(a?.numberOfReviews || 0);
    });
  }

  if (sort === 'popular') {
    return list.sort(
      (a, b) => Number(b?.viewCount || 0) - Number(a?.viewCount || 0)
    );
  }

  return list.sort((a, b) => itemLatestValue(b) - itemLatestValue(a));
};

const mergeLocalAndImdb = ({
  localPageDocs = [],
  localAllDocs = [],
  imdbItems = [],
  sort = 'latest',
  limit = DEFAULT_LIMIT,
}) => {
  const maps = buildLocalMaps(localAllDocs);
  const out = [];
  const seen = new Set();

  const add = (item) => {
    if (!item) return;

    const keys = [
      imdbKey(item),
      titleYearKey(item),
      item?._id ? `id:${String(item._id)}` : '',
    ].filter(Boolean);

    if (keys.some((key) => seen.has(key))) return;

    keys.forEach((key) => seen.add(key));
    out.push(item);
  };

  for (const virtual of imdbItems || []) {
    const localMatch = findLocalMatch(virtual, maps);
    add(localMatch || virtual);
  }

  for (const local of localPageDocs || []) {
    if (out.length >= limit) break;
    add(shapeLocalMovieCard(local));
  }

  return sortMergedItems(out, sort).slice(0, limit);
};

const buildActorResponse = ({ slug, identity, imdbData, localTotal }) => {
  const profile = imdbData?.profile || null;

  const roles =
    Array.isArray(identity?.roles) && identity.roles.length
      ? identity.roles
      : ['actor'];

  const name = clean(profile?.name || identity?.name || titleCaseFromSlug(slug));

  return {
    slug,
    name,
    roles,
    roleLabel: buildRoleLabel(roles),

    image:
      clean(profile?.image) ||
      clean(identity?.localImage) ||
      '/images/placeholder.jpg',

    biography: clean(profile?.description),
    birthday: clean(profile?.birthday),
    deathday: clean(profile?.deathday),
    placeOfBirth: clean(profile?.placeOfBirth),

    knownForDepartment: buildRoleLabel(roles),
    gender: '',
    popularity: 0,
    alsoKnownAs: [],

    imdbId: clean(profile?.imdbId || identity?.actorImdbId),
    imdbUrl: profile?.imdbId
      ? `https://www.imdb.com/name/${profile.imdbId}/`
      : '',

    localCreditsCount: Number(localTotal || 0),
    source: profile?.imdbId ? 'imdb+local' : 'local',
  };
};

/**
 * PUBLIC
 * GET /api/actors/:slug?sort=latest|best|popular&page=1&limit=20
 */
export const getActorBySlug = asyncHandler(async (req, res) => {
  const slug = clean(req.params.slug).toLowerCase();

  if (!slug) {
    res.status(400);
    throw new Error('Actor slug is required');
  }

  const page = Math.max(
    1,
    Number(req.query.page) || Number(req.query.pageNumber) || 1
  );

  const limit = clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const skip = (page - 1) * limit;
  const sort = normalizeSort(req.query.sort);

  const filter = buildActorMovieFilter(slug);

  const [localAllDocs, localPageDocs, localTotal] = await Promise.all([
    Movie.find(filter)
      .sort(localSort(sort))
      .limit(500)
      .select(`${MOVIE_CARD_SELECT} casts director directorSlug`)
      .lean(),

    Movie.find(filter)
      .sort(localSort(sort))
      .skip(skip)
      .limit(limit)
      .select(MOVIE_CARD_SELECT)
      .lean(),

    Movie.countDocuments(filter),
  ]);

  const identity = localAllDocs.length
    ? extractLocalIdentity({ slug, docs: localAllDocs })
    : {
      name: titleCaseFromSlug(slug),
      localImage: '',
      roles: ['actor'],
      actorImdbId: '',
    };

  let imdbData = {
    found: false,
    profile: null,
    results: [],
    pages: 0,
    totalResults: 0,
  };

  try {
    imdbData = await fetchImdbActorProfileAndCredits({
      name: identity.name,
      actorImdbId: identity.actorImdbId,
      roles: identity.roles,
      page,
      limit,
      sort,
    });
  } catch (e) {
    console.warn('[imdb-actor] skipped:', e?.message || e);
  }

  if (!localTotal && !imdbData?.found) {
    res.status(404);
    throw new Error('Actor not found');
  }

  const movies = mergeLocalAndImdb({
    localPageDocs,
    localAllDocs,
    imdbItems: imdbData?.results || [],
    sort,
    limit,
  });

  const actor = buildActorResponse({
    slug,
    identity,
    imdbData,
    localTotal,
  });

  const localPages = Math.ceil(Number(localTotal || 0) / limit) || 0;
  const imdbPages = Number(imdbData?.pages || 0);

  const pages = Math.max(1, localPages, imdbPages);

  const total = Math.max(
    Number(localTotal || 0),
    Number(imdbData?.totalResults || 0),
    movies.length
  );

  res
    .set(
      'Cache-Control',
      'public, max-age=600, s-maxage=600, stale-while-revalidate=86400'
    )
    .json({
      actor,
      movies,
      page,
      pages,
      total,
      localTotal: Number(localTotal || 0),
      imdbTotal: Number(imdbData?.totalResults || 0),
      sort,
      limit,
    });
});

/**
 * PUBLIC
 * GET /api/actors/sitemap?limit=50000
 */
export const getActorsSitemapEntries = asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit, SITEMAP_LIMIT, SITEMAP_LIMIT);

  const [castRows, directorRows] = await Promise.all([
    Movie.aggregate([
      { $match: publicVisibilityFilter },
      { $unwind: '$casts' },
      {
        $project: {
          slug: '$casts.slug',
          name: '$casts.name',
          image: '$casts.image',
          updatedAt: '$updatedAt',
        },
      },
      { $match: { name: { $nin: [null, ''] } } },
      {
        $group: {
          _id: {
            $cond: [
              { $and: [{ $ne: ['$slug', null] }, { $ne: ['$slug', ''] }] },
              '$slug',
              '$name',
            ],
          },
          name: { $first: '$name' },
          image: { $first: '$image' },
          updatedAt: { $max: '$updatedAt' },
          movieCount: { $sum: 1 },
        },
      },
      { $sort: { movieCount: -1, updatedAt: -1 } },
      { $limit: limit },
    ]),

    Movie.aggregate([
      {
        $match: {
          ...publicVisibilityFilter,
          director: { $nin: [null, ''] },
        },
      },
      {
        $project: {
          slug: '$directorSlug',
          name: '$director',
          updatedAt: '$updatedAt',
        },
      },
      {
        $group: {
          _id: {
            $cond: [
              { $and: [{ $ne: ['$slug', null] }, { $ne: ['$slug', ''] }] },
              '$slug',
              '$name',
            ],
          },
          name: { $first: '$name' },
          updatedAt: { $max: '$updatedAt' },
          movieCount: { $sum: 1 },
        },
      },
      { $sort: { movieCount: -1, updatedAt: -1 } },
      { $limit: limit },
    ]),
  ]);

  const map = new Map();

  const addRow = (row, role) => {
    const name = clean(row?.name);
    const rowSlug = slugify(clean(row?._id)) || slugify(name);

    if (!name || !rowSlug) return;

    const existing = map.get(rowSlug) || {
      slug: rowSlug,
      name,
      roles: [],
      movieCount: 0,
      lastmod: null,
    };

    if (!existing.roles.includes(role)) existing.roles.push(role);

    existing.movieCount += Number(row?.movieCount || 0);

    const rowDate = row?.updatedAt ? new Date(row.updatedAt) : null;
    const oldDate = existing.lastmod ? new Date(existing.lastmod) : null;

    if (rowDate && !Number.isNaN(rowDate.getTime())) {
      if (!oldDate || rowDate.getTime() > oldDate.getTime()) {
        existing.lastmod = rowDate.toISOString();
      }
    }

    map.set(rowSlug, existing);
  };

  (castRows || []).forEach((row) => addRow(row, 'actor'));
  (directorRows || []).forEach((row) => addRow(row, 'director'));

  const actors = Array.from(map.values())
    .sort((a, b) => {
      if (b.movieCount !== a.movieCount) return b.movieCount - a.movieCount;
      return a.slug.localeCompare(b.slug);
    })
    .slice(0, limit);

  res
    .set(
      'Cache-Control',
      'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
    )
    .json({
      total: actors.length,
      actors,
    });
});

export default {
  getActorBySlug,
  getActorsSitemapEntries,
};
