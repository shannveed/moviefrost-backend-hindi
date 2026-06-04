// backend/Controllers/ImdbVirtualController.js
import asyncHandler from 'express-async-handler';

import Movie from '../Models/MoviesModel.js';
import {
  buildVirtualMovieFromImdbId,
  normalizeImdbTitleId,
} from '../utils/imdbTitleService.js';

const publicVisibilityFilter = { isPublished: { $ne: false } };

const shapeLocalMovie = (movie) => {
  const doc =
    movie && typeof movie.toObject === 'function' ? movie.toObject() : { ...movie };

  const seg = doc?.slug || doc?._id;

  return {
    ...doc,
    source: 'local',
    isImdbVirtual: false,
    href: seg ? `/movie/${seg}` : '',
    watchHref: seg ? `/watch/${seg}` : '',
  };
};

const findExistingLocalByImdbId = async ({ imdbId, publicOnly = true }) => {
  const safeId = normalizeImdbTitleId(imdbId);
  if (!safeId) return null;

  return Movie.findOne({
    imdbId: safeId,
    ...(publicOnly ? publicVisibilityFilter : {}),
  })
    .select('-reviews')
    .lean();
};

/**
 * PUBLIC
 * GET /api/movies/imdb/virtual/:imdbId
 *
 * Returns:
 * - existing local MovieFrost title if imported
 * - otherwise clean IMDb/OMDb virtual title
 */
export const getImdbVirtualMovie = asyncHandler(async (req, res) => {
  const imdbId = normalizeImdbTitleId(req.params.imdbId);

  if (!imdbId) {
    res.status(400);
    throw new Error('Invalid IMDb title id');
  }

  const existing = await findExistingLocalByImdbId({
    imdbId,
    publicOnly: true,
  });

  if (existing) {
    return res
      .set(
        'Cache-Control',
        'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
      )
      .json(shapeLocalMovie(existing));
  }

  const virtualMovie = await buildVirtualMovieFromImdbId(imdbId);

  if (!virtualMovie) {
    res.status(404);
    throw new Error('IMDb title not found');
  }

  res
    .set(
      'Cache-Control',
      'public, max-age=300, s-maxage=300, stale-while-revalidate=3600'
    )
    .json(virtualMovie);
});

/**
 * PUBLIC
 * POST /api/movies/imdb/resolve
 *
 * Compatibility endpoint.
 */
export const resolveImdbMovie = asyncHandler(async (req, res) => {
  const imdbId = normalizeImdbTitleId(req.body?.imdbId || req.body?.id);

  if (!imdbId) {
    res.status(400);
    throw new Error('Invalid IMDb title id');
  }

  const existing = await findExistingLocalByImdbId({
    imdbId,
    publicOnly: true,
  });

  if (existing) {
    const movie = shapeLocalMovie(existing);

    return res.json({
      virtual: false,
      slug: movie.slug || null,
      href: movie.href,
      watchHref: movie.watchHref,
      movie,
    });
  }

  const virtualMovie = await buildVirtualMovieFromImdbId(imdbId);

  if (!virtualMovie) {
    res.status(404);
    throw new Error('IMDb title not found');
  }

  res.json({
    virtual: true,
    slug: null,
    href: virtualMovie.href,
    watchHref: virtualMovie.watchHref,
    movie: virtualMovie,
  });
});

export default {
  getImdbVirtualMovie,
  resolveImdbMovie,
};
