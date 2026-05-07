// backend/Models/MoviesModel.js
import mongoose from 'mongoose';
import { slugify } from '../utils/slugify.js';

const clampText = (value, max) =>
  String(value ?? '')
    .trim()
    .substring(0, max);

/**
 * Duplicate prevention key:
 * Same type + same normalized name + same year + same language = duplicate.
 */
export const normalizeMovieDedupeText = (value = '') =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

export const buildMovieDedupeKey = ({
  type = '',
  name = '',
  year = '',
  language = '',
} = {}) => {
  const t = normalizeMovieDedupeText(type);
  const n = normalizeMovieDedupeText(name);
  const l = normalizeMovieDedupeText(language);

  const yearNumber = Number(year);
  const y = Number.isFinite(yearNumber)
    ? String(Math.trunc(yearNumber))
    : normalizeMovieDedupeText(year);

  if (!t || !n || !y || !l) return '';

  return `${t}::${n}::${y}::${l}`;
};

/**
 * IMPORTANT:
 * MongoDB text indexes use "language" as the default language_override field.
 * Because Movie documents have a normal "language" field like "Hindi",
 * MongoDB can throw: "language override unsupported: Hindi".
 *
 * Fix:
 * - Use default_language: "none"
 * - Use a non-user field as language_override
 */
export const MOVIE_TEXT_INDEX_NAME = 'movie_text_search_v2';
export const MOVIE_TEXT_LANGUAGE_OVERRIDE = '_mfTextLanguage';
export const MOVIE_TEXT_INDEX_KEYS = {
  name: 'text',
  desc: 'text',
  category: 'text',
  language: 'text',
  seoKeywords: 'text',
};

const reviewSchema = mongoose.Schema(
  {
    userName: { type: String, required: true },
    userImage: { type: String },
    rating: { type: Number, required: true },
    comment: { type: String, required: true },
    adminReply: { type: String, default: '' },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

const episodeSchema = mongoose.Schema(
  {
    seasonNumber: { type: Number, default: 1, min: 1 },
    episodeNumber: { type: Number, required: true },
    title: { type: String, default: '' },
    desc: { type: String },
    duration: { type: Number },

    video: { type: String, required: true },
    videoUrl2: { type: String, default: '' },
    videoUrl3: { type: String, default: '' },
  },
  { timestamps: true }
);

const faqSchema = mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 200 },
    answer: { type: String, required: true, trim: true, maxlength: 800 },
  },
  { _id: false }
);

const moviesSchema = mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    type: {
      type: String,
      required: true,
      enum: ['Movie', 'WebSeries'],
      default: 'Movie',
    },

    name: { type: String, required: true },

    /**
     * Used to prevent duplicate movies/webseries.
     * Same type + name + year + language = same dedupeKey.
     *
     * sparse:true means old existing docs without dedupeKey won't break index creation.
     */
    dedupeKey: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    slug: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
    },

    desc: { type: String, required: true, maxlength: 5000 },

    titleImage: { type: String, required: true },
    image: { type: String, required: true },

    category: { type: String, required: true },
    browseBy: { type: String, required: true },

    thumbnailInfo: { type: String, trim: true, default: '' },

    language: { type: String, required: true },

    year: { type: Number, required: true },
    time: { type: Number, required: true },

    trailerUrl: { type: String, trim: true, default: '' },
    faqs: { type: [faqSchema], default: [] },

    // Movie servers
    video: {
      type: String,
      required: function () {
        return this.type === 'Movie';
      },
    },
    videoUrl2: {
      type: String,
      required: function () {
        return this.type === 'Movie';
      },
    },
    videoUrl3: { type: String, default: '' },

    // Optional extra server
    videoUrl7: { type: String, trim: true, default: '' },

    downloadUrl: { type: String, default: '' },

    // WebSeries episodes
    episodes: {
      type: [episodeSchema],
      required: function () {
        return this.type === 'WebSeries';
      },
    },

    rate: { type: Number, required: true, default: 0 },
    numberOfReviews: { type: Number, required: true, default: 0 },
    reviews: [reviewSchema],

    // Casts
    casts: [
      {
        name: { type: String, required: true, trim: true },
        image: { type: String, required: true, trim: true },
        slug: { type: String, trim: true, index: true, default: '' },
      },
    ],

    director: { type: String, trim: true, default: '' },
    directorSlug: { type: String, trim: true, default: '', index: true },

    imdbId: { type: String, trim: true, default: '', index: true },

    tmdbId: { type: Number, default: null, index: true },

    tmdbType: {
      type: String,
      enum: ['', 'movie', 'tv'],
      default: '',
      trim: true,
      index: true,
    },

    tmdbCreditsUpdatedAt: { type: Date, default: null, index: true },

    externalRatings: {
      imdb: {
        rating: { type: Number, default: null },
        votes: { type: Number, default: null },
        url: { type: String, default: '' },
      },
      rottenTomatoes: {
        rating: { type: Number, default: null },
        url: { type: String, default: '' },
      },
    },
    externalRatingsUpdatedAt: { type: Date, default: null, index: true },

    seoTitle: { type: String, maxlength: 100, trim: true, default: '' },
    seoDescription: { type: String, maxlength: 300, trim: true, default: '' },
    seoKeywords: { type: String, trim: true, default: '' },

    viewCount: { type: Number, default: 0 },

    latest: { type: Boolean, default: false },
    previousHit: { type: Boolean, default: false },

    latestNew: { type: Boolean, default: false, index: true },
    latestNewAt: { type: Date, default: null, index: true },

    banner: { type: Boolean, default: false, index: true },
    bannerAt: { type: Date, default: null, index: true },

    isPublished: { type: Boolean, default: true, index: true },

    orderIndex: { type: Number, default: null, index: true },
  },
  { timestamps: true }
);

moviesSchema.pre('validate', function (next) {
  try {
    this.name = String(this.name || '').trim();
    this.type = String(this.type || '').trim();
    this.language = String(this.language || '').trim();

    const yearNumber = Number(this.year);
    if (Number.isFinite(yearNumber)) {
      this.year = Math.trunc(yearNumber);
    }

    this.dedupeKey =
      buildMovieDedupeKey({
        type: this.type,
        name: this.name,
        year: this.year,
        language: this.language,
      }) || undefined;

    if (Array.isArray(this.casts)) {
      for (const c of this.casts) {
        if (!c) continue;
        const n = String(c.name || '').trim();
        c.name = n;
        c.image = String(c.image || '').trim();
        c.slug = n ? slugify(n) : '';
      }
    }

    const d = String(this.director || '').trim();
    this.director = d;
    this.directorSlug = d ? slugify(d) : '';

    this.seoTitle = clampText(this.seoTitle, 100);
    this.seoDescription = clampText(this.seoDescription, 300);
    this.seoKeywords = String(this.seoKeywords ?? '').trim();

    if (Array.isArray(this.faqs)) {
      this.faqs = this.faqs
        .map((f) => ({
          question: clampText(f?.question, 200),
          answer: clampText(f?.answer, 800),
        }))
        .filter((f) => f.question && f.answer)
        .slice(0, 5);
    }

    const t = String(this.tmdbType ?? '').trim();
    if (!['', 'movie', 'tv'].includes(t)) {
      this.tmdbType = '';
    }
  } catch {
    // ignore cleanup failures
  }

  next();
});

/**
 * Safe text index.
 * Do NOT use MongoDB default language_override: "language".
 */
moviesSchema.index(MOVIE_TEXT_INDEX_KEYS, {
  name: MOVIE_TEXT_INDEX_NAME,
  default_language: 'none',
  language_override: MOVIE_TEXT_LANGUAGE_OVERRIDE,
});

// Duplicate prevention index
moviesSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    sparse: true,
    name: 'movie_dedupe_key_unique',
  }
);

// Other indexes
moviesSchema.index({ category: 1, createdAt: -1 });
moviesSchema.index({ browseBy: 1, createdAt: -1 });
moviesSchema.index({ rate: -1 });
moviesSchema.index({ viewCount: -1 });
moviesSchema.index({ latest: -1, previousHit: 1, createdAt: -1 });
moviesSchema.index({ 'episodes.seasonNumber': 1 });

export default mongoose.models.Movie || mongoose.model('Movie', moviesSchema);
