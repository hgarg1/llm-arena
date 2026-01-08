import { Router } from 'express';
import * as homeController from '../controllers/home.controller';
import * as matchController from '../controllers/match.controller';
import * as modelController from '../controllers/model.controller';
import * as accessController from '../controllers/access.controller';
import publicRoutes from './public.routes';
import authRoutes from './auth.routes';
import accountRoutes from './account.routes';
import adminRoutes from './admin.routes';
import investorRoutes from './investor.routes';
import chatRoutes from './chat.routes';
import apiRoutes from './api.routes';
import { isAuthenticated } from '../middleware/auth.middleware';
import { matchCreateRateLimit } from '../middleware/rate-limit.middleware';
import { apiKeyAuthOptional, apiKeyUsageTracker, requireApiScope } from '../middleware/api-key.middleware';

const router = Router();

// API V1
router.use('/api/v1', apiRoutes);

// Public Pages
router.use('/', publicRoutes);
router.use('/auth', authRoutes);
router.use('/account', accountRoutes);
router.use('/admin', adminRoutes);
router.use('/investors', investorRoutes);
router.use('/chat', chatRoutes);

// App Pages (Override home if needed, but PublicController handles root)
// router.get('/', homeController.index); // Removed in favor of PublicController.home

// Matches
router.get('/matches', matchController.list);
// Protect match creation
router.get('/matches/create', isAuthenticated, matchController.createPage);
router.post('/matches', isAuthenticated, matchCreateRateLimit, matchController.create);

router.get('/matches/:id', matchController.detail);
router.get('/matches/:id/events', matchController.events); // API for Replay

// Access Requests
router.post('/access/request', isAuthenticated, accessController.requestAccess);
router.get('/access/requested', isAuthenticated, accessController.requestConfirmation);

// Models
router.get('/api/models', apiKeyAuthOptional, requireApiScope('models.read'), apiKeyUsageTracker, modelController.apiList);
router.get('/models', modelController.list);
router.get('/models/:id', modelController.detail);

// Admin (Simplified for MVP, no auth middleware yet)
// router.get('/admin', adminController.dashboard);

export default router;
