// backend/Controllers/UserController.js
import asyncHandler from 'express-async-handler';
import User from '../Models/UserModel.js';
import bcrypt from 'bcryptjs';
import { generateToken } from '../middlewares/Auth.js';

/* ============================================================
   Auth Cookie (for Next.js SSR admin preview)
   ============================================================ */
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'mf_token';
const AUTH_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

const isLocalLikeUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return false;

  try {
    const url = new URL(raw);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(raw);
  }
};

const shouldUseSecureAuthCookie = () => {
  const forced = String(process.env.AUTH_COOKIE_SECURE || '')
    .trim()
    .toLowerCase();

  if (forced === 'true') return true;
  if (forced === 'false') return false;

  const frontendUrl = String(process.env.PUBLIC_FRONTEND_URL || '').trim();
  if (isLocalLikeUrl(frontendUrl)) return false;

  return process.env.NODE_ENV === 'production';
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: shouldUseSecureAuthCookie(),
  sameSite: 'lax',
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE_MS,
});

const clearCookieOptions = () => ({
  httpOnly: true,
  secure: shouldUseSecureAuthCookie(),
  sameSite: 'lax',
  path: '/',
});

const setAuthCookie = (res, token) => {
  try {
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
  } catch (e) {
    console.warn('[auth-cookie] failed to set cookie:', e?.message || e);
  }
};

const clearAuthCookie = (res) => {
  try {
    res.clearCookie(AUTH_COOKIE_NAME, clearCookieOptions());
  } catch (e) {
    console.warn('[auth-cookie] failed to clear cookie:', e?.message || e);
  }
};

/* ============================================================
   Google OAuth helpers
   ============================================================ */
const GOOGLE_CLIENT_ID_RE =
  /^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;

const GOOGLE_CLIENT_IDS = String(process.env.GOOGLE_CLIENT_ID || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const fetchJsonWithTimeout = async (url, init = {}, timeoutMs = 8000) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg =
        data?.error_description ||
        data?.error ||
        data?.message ||
        `Google request failed: ${res.status}`;

      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
};

const validateBackendGoogleConfig = () => {
  if (!GOOGLE_CLIENT_IDS.length) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID in backend env.');
  }

  const invalid = GOOGLE_CLIENT_IDS.find((id) => !GOOGLE_CLIENT_ID_RE.test(id));

  if (invalid) {
    throw new Error(
      'Backend GOOGLE_CLIENT_ID is invalid. Use full Web Client ID ending with .apps.googleusercontent.com'
    );
  }
};

const fetchGoogleUserFromAccessToken = async (accessToken) => {
  validateBackendGoogleConfig();

  const tokenInfoUrl = `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(
    accessToken
  )}`;

  const tokenInfo = await fetchJsonWithTimeout(tokenInfoUrl);

  const aud = String(tokenInfo?.aud || '').trim();

  if (aud && !GOOGLE_CLIENT_IDS.includes(aud)) {
    throw new Error(
      'Google token was not issued for this OAuth client. Check frontend NEXT_PUBLIC_GOOGLE_CLIENT_ID and backend GOOGLE_CLIENT_ID.'
    );
  }

  const userInfo = await fetchJsonWithTimeout(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const email = String(userInfo?.email || '').trim().toLowerCase();
  const fullName = String(userInfo?.name || '').trim();
  const picture = String(userInfo?.picture || '').trim();
  const googleSub = String(userInfo?.sub || tokenInfo?.sub || '').trim();

  if (!email) {
    throw new Error('Email not provided by Google');
  }

  if (userInfo?.email_verified === false) {
    throw new Error('Google email is not verified');
  }

  return {
    email,
    fullName: fullName || email.split('@')[0],
    picture,
    googleSub: googleSub || email,
  };
};

// @desc Register user
// @route POST /api/users
// @access Public
const registerUser = asyncHandler(async (req, res) => {
  const { fullName, email, password, image } = req.body;

  const cleanEmail = String(email || '').trim().toLowerCase();

  const userExists = await User.findOne({ email: cleanEmail });
  if (userExists) {
    res.status(400);
    throw new Error('User already exists');
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const user = await User.create({
    fullName,
    email: cleanEmail,
    password: hashedPassword,
    image,
  });

  if (!user) {
    res.status(400);
    throw new Error('Invalid user data');
  }

  const token = generateToken(user._id);
  setAuthCookie(res, token);

  res.status(201).json({
    _id: user._id,
    fullName: user.fullName,
    email: user.email,
    image: user.image,
    isAdmin: user.isAdmin,
    token,
  });
});

// @desc Login user
// @route POST /api/users/login
// @access Public
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const cleanEmail = String(email || '').trim().toLowerCase();

  const user = await User.findOne({ email: cleanEmail });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const token = generateToken(user._id);
  setAuthCookie(res, token);

  res.json({
    _id: user._id,
    fullName: user.fullName,
    email: user.email,
    image: user.image,
    isAdmin: user.isAdmin,
    token,
  });
});

// @desc Logout user
// @route POST /api/users/logout
// @access Public
const logoutUser = asyncHandler(async (_req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ message: 'Logged out' });
});

// @desc Update user profile
// @route PUT /api/users
// @access Private
const updateUserProfile = asyncHandler(async (req, res) => {
  const { fullName, email, image } = req.body;

  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.fullName = fullName || user.fullName;

  if (email) {
    user.email = String(email).trim().toLowerCase();
  }

  user.image = image || user.image;

  const updatedUser = await user.save();

  const token = generateToken(updatedUser._id);
  setAuthCookie(res, token);

  res.json({
    _id: updatedUser._id,
    fullName: updatedUser.fullName,
    email: updatedUser.email,
    image: updatedUser.image,
    isAdmin: updatedUser.isAdmin,
    token,
  });
});

// @desc Delete user profile
// @route DELETE /api/users
// @access Private
const deleteUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (user.isAdmin) {
    res.status(400);
    throw new Error("Can't delete admin user");
  }

  await user.deleteOne();

  clearAuthCookie(res);
  res.json({ message: 'User deleted successfully' });
});

// @desc Change user password
// @route PUT /api/users/password
// @access Private
const changeUserPassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id);

  if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
    res.status(401);
    throw new Error('Invalid old password');
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(newPassword, salt);

  user.password = hashedPassword;
  await user.save();

  res.json({ message: 'Password changed!' });
});

// @desc Login user with Google
// @route POST /api/users/google-login
// @access Public
const googleLogin = asyncHandler(async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) {
    res.status(400);
    throw new Error('Access token is required');
  }

  let googleUser;

  try {
    googleUser = await fetchGoogleUserFromAccessToken(accessToken);
  } catch (e) {
    res.status(e?.status === 400 || e?.status === 401 ? 401 : 400);
    throw new Error(e?.message || 'Google login failed');
  }

  let user = await User.findOne({ email: googleUser.email });

  if (!user) {
    const seed =
      googleUser.googleSub + String(process.env.JWT_SECRET || 'moviefrost');

    const hashedPassword = await bcrypt.hash(seed, 10);

    user = await User.create({
      fullName: googleUser.fullName,
      email: googleUser.email,
      password: hashedPassword,
      image: googleUser.picture || '',
    });
  } else {
    let changed = false;

    if (!user.image && googleUser.picture) {
      user.image = googleUser.picture;
      changed = true;
    }

    if (!user.fullName && googleUser.fullName) {
      user.fullName = googleUser.fullName;
      changed = true;
    }

    if (changed) await user.save();
  }

  const token = generateToken(user._id);
  setAuthCookie(res, token);

  res.json({
    _id: user._id,
    fullName: user.fullName,
    email: user.email,
    image: user.image,
    isAdmin: user.isAdmin,
    token,
  });
});

/**
 * @desc Get all liked movies
 * @route GET /api/users/favorites
 * @access Private
 */
const getLikedMovies = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('likedMovies');

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json(user.likedMovies);
});

// @desc Add movie to liked movies
// @route POST /api/users/favorites
// @access Private
const addLikedMovie = asyncHandler(async (req, res) => {
  const { movieId } = req.body;

  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (user.likedMovies.includes(movieId)) {
    res.status(400);
    throw new Error('Movie already liked');
  }

  user.likedMovies.push(movieId);
  await user.save();

  res.json(user.likedMovies);
});

// @desc Delete all liked movies
// @route DELETE /api/users/favorites
// @access Private
const deleteLikedMovies = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  user.likedMovies = [];
  await user.save();

  res.json({ message: 'All favorite movies deleted successfully' });
});

// @desc Get all users
// @route GET /api/users
// @access Private/Admin
const getUsers = asyncHandler(async (_req, res) => {
  const users = await User.find({}).select('-password');
  res.json(users);
});

// @desc Delete user
// @route DELETE /api/users/:id
// @access Private/Admin
const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (user.isAdmin) {
    res.status(400);
    throw new Error("Can't delete admin user");
  }

  await user.deleteOne();

  res.json({ message: 'User deleted successfully' });
});

export {
  registerUser,
  loginUser,
  logoutUser,
  updateUserProfile,
  deleteUserProfile,
  changeUserPassword,
  getLikedMovies,
  addLikedMovie,
  deleteLikedMovies,
  getUsers,
  deleteUser,
  googleLogin,
};
