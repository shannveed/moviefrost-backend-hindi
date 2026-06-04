// backend/routes/ActorsRouter.js
import express from 'express';
import {
  getActorBySlug,
  getActorsSitemapEntries,
} from '../Controllers/ActorsController.js';

const router = express.Router();

// Public sitemap data must come before "/:slug"
router.get('/sitemap', getActorsSitemapEntries);

// Public actor/director page data
router.get('/:slug', getActorBySlug);

export default router;
