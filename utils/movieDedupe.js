// backend/utils/movieDedupe.js
import mongoose from 'mongoose';
import Movie, {
  buildMovieDedupeKey,
  normalizeMovieDedupeText,
} from '../Models/MoviesModel.js';

const escapeRegex = (value = '') =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

export const buildDuplicateMovieMessage = (existing) => {
  const name = existing?.name ? `"${existing.name}"` : 'This title';
  const year = existing?.year ? ` (${existing.year})` : '';
  const type = existing?.type ? `${existing.type}` : 'Movie/WebSeries';

  return `${type} ${name}${year} already exists in database. Duplicate skipped.`;
};

export const findDuplicateMovie = async ({
  type,
  name,
  year,
  language,
  excludeId = null,
} = {}) => {
  const cleanType = String(type || '').trim();
  const cleanName = String(name || '').trim();
  const cleanLanguage = String(language || '').trim();

  if (!cleanType || !cleanName || !cleanLanguage || year === undefined || year === null || year === '') {
    return null;
  }

  const dedupeKey = buildMovieDedupeKey({
    type: cleanType,
    name: cleanName,
    year,
    language: cleanLanguage,
  });

  const normalizedName = normalizeMovieDedupeText(cleanName);
  const normalizedLanguage = normalizeMovieDedupeText(cleanLanguage);

  const yearNumber = Number(year);
  const yearQueryValue = Number.isFinite(yearNumber) ? yearNumber : year;

  const query = {
    $or: [
      ...(dedupeKey ? [{ dedupeKey }] : []),
      {
        type: cleanType,
        year: yearQueryValue,
        name: new RegExp(`^${escapeRegex(normalizedName)}$`, 'i'),
        language: new RegExp(`^${escapeRegex(normalizedLanguage)}$`, 'i'),
      },
    ],
  };

  if (excludeId && isValidObjectId(excludeId)) {
    query._id = { $ne: excludeId };
  }

  return Movie.findOne(query)
    .select('_id slug name type year language dedupeKey')
    .lean();
};

export const assertNoDuplicateMovie = async ({
  type,
  name,
  year,
  language,
  excludeId = null,
} = {}) => {
  const duplicate = await findDuplicateMovie({
    type,
    name,
    year,
    language,
    excludeId,
  });

  if (!duplicate) return null;

  const err = new Error(buildDuplicateMovieMessage(duplicate));
  err.statusCode = 409;
  err.code = 'DUPLICATE_MOVIE';
  err.duplicate = duplicate;

  throw err;
};

export const buildBulkDuplicateKey = ({ type, name, year, language } = {}) =>
  buildMovieDedupeKey({ type, name, year, language });
