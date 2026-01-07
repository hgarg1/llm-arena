import { Router } from 'express';
import * as accountController from '../controllers/account.controller';
import { isAuthenticated } from '../middleware/auth.middleware';
import { uploadAvatar } from '../middleware/upload.middleware';

const router = Router();

router.get('/', isAuthenticated, accountController.settingsPage);
router.post('/profile', isAuthenticated, uploadAvatar, accountController.updateProfile);
router.post('/upgrade', isAuthenticated, accountController.upgradeTier);
router.post('/password', isAuthenticated, accountController.changePassword);
router.post('/delete', isAuthenticated, accountController.deleteAccount);
router.post('/verify', isAuthenticated, accountController.verifyAccount);
router.post('/api-keys', isAuthenticated, accountController.createApiKey);
router.get('/mfa/setup', isAuthenticated, accountController.setupMfaPage);
router.post('/mfa/verify', isAuthenticated, accountController.verifyMfaSetup);
router.post('/mfa/disable', isAuthenticated, accountController.disableMfa);

export default router;
