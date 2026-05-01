// backend/config/db.js
import mongoose from 'mongoose';

const globalForMongoose = globalThis;

if (!globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__) {
  globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__ = {
    conn: null,
    promise: null,
  };
}

const cache = globalForMongoose.__MOVIEFROST_MONGOOSE_CACHE__;

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
