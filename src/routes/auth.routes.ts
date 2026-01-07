import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { loginRateLimit } from '../middleware/rate-limit.middleware';
import { requirePasskeyEnabled } from '../middleware/auth.middleware';

const router = Router();

router.get('/login', authController.loginPage);
router.post('/login', loginRateLimit, authController.login);
router.post('/logout', authController.logout);

router.get('/signup', authController.signupPage);
router.post('/signup', authController.signup);

router.get('/forgot-password', authController.forgotPasswordPage);
router.post('/forgot-password', authController.forgotPassword);

router.get('/reset-password/:token', authController.resetPasswordPage);
router.post('/reset-password', authController.resetPassword);

router.get('/verify-email/:token', authController.verifyEmail);
router.get('/verify-phone', authController.verifyPhonePage);
router.post('/verify-phone', authController.verifyPhone);

router.post('/passkey/register/options', requirePasskeyEnabled, authController.getPasskeyRegistration);
router.post('/passkey/register/verify', requirePasskeyEnabled, authController.verifyPasskeyRegistration);
router.post('/passkey/auth/options', requirePasskeyEnabled, authController.getPasskeyAuthOptions);
router.post('/passkey/auth/verify', requirePasskeyEnabled, authController.verifyPasskeyAuth);

export default router;
