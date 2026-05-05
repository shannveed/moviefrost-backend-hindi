// backend/config/db.js
import mongoose from 'mongoose';

const globalForMongoose = globalThis;

if (!globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__) {
  globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__ = {
    conn: null,
    promise: null,
  };
}

if (!globalForMongoose.__MOVIEFROST_MONGO_INDEX_MAINTENANCE_CACHE__) {
  globalForMongoose.__MOVIEFROST_MONGO_INDEX_MAINTENANCE_CACHE__ = {
    done: false,
    promise: null,
    result: null,
  };
}

const cache = globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__;
const indexMaintenanceCache =
  globalForMongoose.__MOVIEFROST_MONGO_INDEX_MAINTENANCE_CACHE__;

const READY_STATE_LABELS = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const getNumberEnv = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const getMongoStatus = () => ({
  readyState: mongoose.connection.readyState,
  state:
    READY_STATE_LABELS[mongoose.connection.readyState] ||
    String(mongoose.connection.readyState),
  host: mongoose.connection.host || '',
  name: mongoose.connection.name || '',
});

const printMongoHelp = (error) => {
  const msg = String(error?.message || error || '');

  console.error('❌ MongoDB connection failed:', msg);

  if (/bad auth|authentication failed/i.test(msg)) {
    console.error('');
    console.error('MongoDB auth checklist:');
    console.error('1) Replace password in MONGO_URI with the real Atlas DB user password.');
    console.error('2) If password has @ # : / ? & characters, URL-encode the password.');
    console.error('3) Atlas > Database Access: confirm username/password.');
    console.error('4) Atlas > Network Access: allow Vercel egress or 0.0.0.0/0 for testing.');
    console.error('5) Confirm database user has access to the target database.');
    console.error('');
  }

  if (/querysrv|enotfound|getaddrinfo|server selection|timed out|timeout/i.test(msg)) {
    console.error('');
    console.error('MongoDB network checklist:');
    console.error('1) In Vercel backend project, add MONGO_URI in Environment Variables.');
    console.error('2) In Atlas > Network Access, allow 0.0.0.0/0 for Vercel testing.');
    console.error('3) Make sure the cluster is active and not paused.');
    console.error('4) Use mongodb+srv:// URI copied from Atlas Connect dialog.');
    console.error('');
  }
};

/* ============================================================
   Movie text index repair
   ============================================================ */

/**
 * Why this exists:
 * MongoDB text indexes use language_override: "language" by default.
 * Your Movie documents also have a normal field:
 *   language: "Hindi"
 *
 * That makes MongoDB treat "Hindi" as a text index language override and fail:
 *   language override unsupported: Hindi
 *
 * This maintenance code drops legacy Movie text indexes and creates a safe one:
 *   default_language: "none"
 *   language_override: "_mfTextLanguage"
 */
const isIndexMaintenanceDisabled = () => {
  const raw = String(process.env.MONGO_AUTO_FIX_TEXT_INDEXES ?? 'true')
    .trim()
    .toLowerCase();

  return ['false', '0', 'no', 'off'].includes(raw);
};

const isTextIndex = (idx = {}) =>
  Object.values(idx?.key || {}).some((value) => String(value) === 'text');

const isIndexNotFoundLike = (error) => {
  const msg = String(error?.message || error || '');
  return /index not found|index.*not.*found|ns not found|namespace not found/i.test(
    msg
  );
};

const listIndexesSafe = async (collection) => {
  try {
    return await collection.indexes();
  } catch (error) {
    if (isIndexNotFoundLike(error)) return [];
    throw error;
  }
};

const hasExactTextKeys = (idx = {}, desiredKeys = {}) => {
  const current = idx?.key || {};
  const currentKeys = Object.keys(current);
  const desiredKeyNames = Object.keys(desiredKeys);

  if (currentKeys.length !== desiredKeyNames.length) return false;

  return desiredKeyNames.every(
    (key) => String(current[key]) === String(desiredKeys[key])
  );
};

const isSafeDesiredMovieTextIndex = (
  idx = {},
  {
    textIndexName,
    textIndexKeys,
    textLanguageOverride,
  } = {}
) =>
  idx?.name === textIndexName &&
  hasExactTextKeys(idx, textIndexKeys) &&
  String(idx?.default_language || '') === 'none' &&
  String(idx?.language_override || '') === textLanguageOverride;

const ensureSafeMovieTextIndex = async () => {
  if (isIndexMaintenanceDisabled()) {
    return {
      skipped: true,
      reason: 'MONGO_AUTO_FIX_TEXT_INDEXES=false',
    };
  }

  const movieModule = await import('../Models/MoviesModel.js');

  const Movie = movieModule.default;

  const textIndexName =
    movieModule.MOVIE_TEXT_INDEX_NAME || 'movie_text_search_v2';

  const textLanguageOverride =
    movieModule.MOVIE_TEXT_LANGUAGE_OVERRIDE || '_mfTextLanguage';

  const textIndexKeys =
    movieModule.MOVIE_TEXT_INDEX_KEYS || {
      name: 'text',
      desc: 'text',
      category: 'text',
      language: 'text',
      seoKeywords: 'text',
    };

  const collection = Movie.collection;

  const beforeIndexes = await listIndexesSafe(collection);
  const beforeTextIndexes = beforeIndexes.filter(isTextIndex);

  const alreadySafe =
    beforeTextIndexes.length === 1 &&
    isSafeDesiredMovieTextIndex(beforeTextIndexes[0], {
      textIndexName,
      textIndexKeys,
      textLanguageOverride,
    });

  if (alreadySafe) {
    return {
      skipped: false,
      changed: false,
      dropped: [],
      created: false,
      textIndexName,
    };
  }

  const dropped = [];

  for (const idx of beforeTextIndexes) {
    const name = String(idx?.name || '').trim();
    if (!name || name === '_id_') continue;

    try {
      await collection.dropIndex(name);
      dropped.push(name);
    } catch (error) {
      if (isIndexNotFoundLike(error)) continue;
      throw error;
    }
  }

  let created = false;

  try {
    await collection.createIndex(textIndexKeys, {
      name: textIndexName,
      default_language: 'none',
      language_override: textLanguageOverride,
      background: true,
    });

    created = true;
  } catch (error) {
    /**
     * Race-safe:
     * In serverless, two cold starts may repair indexes at the same time.
     * If another instance already created the safe index, re-check and accept it.
     */
    const msg = String(error?.message || error || '');

    if (
      /already exists|equivalent index|only one text index/i.test(msg)
    ) {
      const afterIndexes = await listIndexesSafe(collection);
      const afterTextIndexes = afterIndexes.filter(isTextIndex);

      const safeNow =
        afterTextIndexes.length === 1 &&
        isSafeDesiredMovieTextIndex(afterTextIndexes[0], {
          textIndexName,
          textIndexKeys,
          textLanguageOverride,
        });

      if (safeNow) {
        return {
          skipped: false,
          changed: dropped.length > 0,
          dropped,
          created: false,
          textIndexName,
          raceResolved: true,
        };
      }
    }

    throw error;
  }

  return {
    skipped: false,
    changed: dropped.length > 0 || created,
    dropped,
    created,
    textIndexName,
  };
};

const ensureMongoRuntimeIndexes = async () => {
  if (indexMaintenanceCache.done) return indexMaintenanceCache.result;

  if (!indexMaintenanceCache.promise) {
    indexMaintenanceCache.promise = ensureSafeMovieTextIndex();
  }

  try {
    const result = await indexMaintenanceCache.promise;

    indexMaintenanceCache.done = true;
    indexMaintenanceCache.result = result;

    return result;
  } catch (error) {
    indexMaintenanceCache.promise = null;
    indexMaintenanceCache.done = false;
    indexMaintenanceCache.result = null;
    throw error;
  }
};

const runMongoRuntimeIndexMaintenance = async () => {
  try {
    const result = await ensureMongoRuntimeIndexes();

    if (!result || result.skipped) return result;

    if (result.changed || result.dropped?.length || result.created) {
      console.log(
        `[mongo-index] Movie text index ready: ${result.textIndexName}. dropped=${JSON.stringify(
          result.dropped || []
        )}, created=${!!result.created}`
      );
    }

    return result;
  } catch (error) {
    console.error(
      '❌ MongoDB index maintenance failed:',
      error?.message || error
    );
    console.error(
      'Movie create/update may fail with "language override unsupported" until the legacy Movie text index is repaired.'
    );
    console.error(
      'Fix: allow index create/drop permissions, or manually drop the old Movie text index from MongoDB Atlas.'
    );

    return {
      ok: false,
      error: String(error?.message || error || 'index_maintenance_failed'),
    };
  }
};

// Connect MongoDB with mongoose
export const connectDB = async () => {
  const uri = String(process.env.MONGO_URI || '').trim();

  if (!uri) {
    const err = new Error('MONGO_URI is missing in environment variables');
    printMongoHelp(err);

    if (!process.env.VERCEL) process.exit(1);
    throw err;
  }

  // Already connected
  if (mongoose.connection.readyState === 1) {
    if (!cache.conn) cache.conn = mongoose;

    // Ensure concurrent/cold-start writes also wait for text-index repair.
    await runMongoRuntimeIndexMaintenance();

    return cache.conn;
  }

  // Reuse active promise during cold starts / concurrent requests
  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: getNumberEnv(
        'MONGO_SERVER_SELECTION_TIMEOUT_MS',
        10000
      ),
      connectTimeoutMS: getNumberEnv('MONGO_CONNECT_TIMEOUT_MS', 10000),
      socketTimeoutMS: getNumberEnv('MONGO_SOCKET_TIMEOUT_MS', 45000),
      maxPoolSize: getNumberEnv('MONGO_MAX_POOL_SIZE', 10),
      minPoolSize: 0,

      // Helps Vercel/serverless environments that sometimes struggle with IPv6.
      family: 4,
    });
  }

  try {
    cache.conn = await cache.promise;

    console.log(
      `MongoDB Connected: ${cache.conn.connection.host}/${cache.conn.connection.name}`
    );

    await runMongoRuntimeIndexMaintenance();

    return cache.conn;
  } catch (error) {
    cache.promise = null;
    cache.conn = null;

    printMongoHelp(error);

    // Local dev should stop clearly.
    // Vercel/serverless should throw instead of process.exit.
    if (!process.env.VERCEL) {
      process.exit(1);
    }

    throw error;
  }
};
