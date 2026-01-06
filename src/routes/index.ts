import { Router } from 'express';
import * as homeController from '../controllers/home.controller';
import * as matchController from '../controllers/match.controller';
import * as modelController from '../controllers/model.controller';
import publicRoutes from './public.routes';

const router = Router();

// Public Pages
router.use('/', publicRoutes);

// App Pages (Override home if needed, but PublicController handles root)
// router.get('/', homeController.index); // Removed in favor of PublicController.home

// Matches
router.get('/matches', matchController.list);
router.get('/matches/create', matchController.createPage);
router.post('/matches', matchController.create);
router.get('/matches/:id', matchController.detail);
router.get('/matches/:id/events', matchController.events); // API for Replay

// Models
router.get('/models', modelController.list);
router.get('/models/:id', modelController.detail);

// Admin (Simplified for MVP, no auth middleware yet)
// router.get('/admin', adminController.dashboard);

export default router;
