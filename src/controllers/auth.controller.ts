import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { UserRepository } from '../repositories/user.repository';
import { prisma } from '../config/db';
import crypto from 'crypto';
import { comms } from '../services/communication';
import { webAuthnService } from '../services/webauthn.service';

const userRepo = new UserRepository();

// ... existing login/logout ...
export const loginPage = (req: Request, res: Response) => {
  res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: null });
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const settings = res.locals.settings || {};

  try {
    const user = await userRepo.findByEmail(email);
    if (!user) {
      return res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: 'Invalid credentials' });
    }

    if (!user.password_hash) {
        return res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: 'Please sign in with SSO' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: 'Invalid credentials' });
    }

    const requireEmailVerification = settings.auth_require_email_verification !== 'false';
    if (requireEmailVerification && !user.email_verified) {
      if (user.role === 'ADMIN') {
        await prisma.user.update({
          where: { id: user.id },
          data: { email_verified: true, email_verification_token: null }
        });
      } else {
        return res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: 'Please verify your email before signing in' });
      }
    }

    // Set Session
    (req.session as any).userId = user.id;
    (req.session as any).user = { id: user.id, email: user.email, role: user.role, tier: user.tier };
    (req.session as any).sessionVersion = settings.session_version || '1';
    const remember = req.body.remember_me === 'on';
    const idleMinutes = parseInt(settings.session_idle_minutes || '60', 10);
    const rememberDays = parseInt(settings.session_remember_days || '7', 10);
    if (req.session.cookie) {
      const maxAgeMinutes = remember ? rememberDays * 24 * 60 : idleMinutes;
      req.session.cookie.maxAge = Math.max(1, maxAgeMinutes) * 60 * 1000;
    }
    
    req.session.save(() => {
        res.redirect('/');
    });

  } catch (error) {
    console.error(error);
    res.render('auth/login', { title: 'Sign In', path: '/auth/login', error: 'An error occurred' });
  }
};

export const logout = (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
};

export const signupPage = (req: Request, res: Response) => {
    res.render('auth/signup', { title: 'Create Account', path: '/auth/signup', error: null, step: 1 });
};

export const signup = async (req: Request, res: Response) => {
    const { email, password, name, company, job_title, phone } = req.body;
    const settings = res.locals.settings || {};
    
    try {
        const existing = await userRepo.findByEmail(email);
        if (existing) {
            return res.render('auth/signup', { title: 'Create Account', path: '/auth/signup', error: 'Email already exists', step: 1 });
        }

        const minLen = parseInt(settings.auth_password_min_length || '12', 10);
        const requireUpper = settings.auth_password_require_upper !== 'false';
        const requireLower = settings.auth_password_require_lower !== 'false';
        const requireNumber = settings.auth_password_require_number !== 'false';
        const requireSpecial = settings.auth_password_require_special !== 'false';
        const errors = [];
        if ((password || '').length < minLen) errors.push(`at least ${minLen} characters`);
        if (requireUpper && !/[A-Z]/.test(password || '')) errors.push('an uppercase letter');
        if (requireLower && !/[a-z]/.test(password || '')) errors.push('a lowercase letter');
        if (requireNumber && !/[0-9]/.test(password || '')) errors.push('a number');
        if (requireSpecial && !/[^A-Za-z0-9]/.test(password || '')) errors.push('a special character');
        if (errors.length > 0) {
            return res.render('auth/signup', { title: 'Create Account', path: '/auth/signup', error: `Password must include ${errors.join(', ')}`, step: 1 });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const defaultTier = ['FREE', 'PRO', 'ENTERPRISE'].includes(settings.default_user_tier) ? settings.default_user_tier : 'FREE';
        
        // Generate Tokens
        const emailToken = crypto.randomBytes(32).toString('hex');
        const phoneCode = phone ? Math.floor(100000 + Math.random() * 900000).toString() : null;

        const user = await prisma.user.create({
            data: {
                email,
                password_hash: passwordHash,
                name,
                company,
                job_title,
                phone: phone || null,
                role: 'USER',
                tier: defaultTier as any,
                email_verification_token: emailToken,
                phone_verification_code: phoneCode
            }
        });

        // Send Notifications
        const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/auth/verify-email/${emailToken}`;
        await comms.sendEmail(email, 'Verify your email', `Welcome! Please verify your email: ${verifyLink}`);

        if (phone && phoneCode) {
            await comms.sendSMS(phone, `Your verification code is: ${phoneCode}`);
        }

        // Auto login
        (req.session as any).userId = user.id;
        (req.session as any).user = { id: user.id, email: user.email, role: user.role, tier: user.tier };
        (req.session as any).sessionVersion = settings.session_version || '1';
        
        if (phone) {
            res.redirect('/auth/verify-phone');
        } else {
            res.redirect('/');
        }

    } catch (e) {
        console.error(e);
        res.render('auth/signup', { title: 'Create Account', path: '/auth/signup', error: 'Registration failed', step: 1 });
    }
};

export const verifyEmail = async (req: Request, res: Response) => {
    const { token } = req.params;
    const user = await prisma.user.findFirst({ where: { email_verification_token: token } });

    if (user) {
        await prisma.user.update({
            where: { id: user.id },
            data: { email_verified: true, email_verification_token: null }
        });
        // Auto-login if session exists? Or just show success.
        return res.render('auth/verify-success', { title: 'Email Verified', state: 'success', user });
    } 
    
    // Check if user is already verified (token might be null now)
    // We can't easily check "already verified" by token if token is gone.
    // But we can just show "Invalid or Expired" with a nice message.
    return res.render('auth/verify-success', { title: 'Email Verification', state: 'invalid' });
};

export const verifyPhonePage = (req: Request, res: Response) => {
    res.render('auth/verify-phone', { title: 'Verify Phone', path: '/auth/verify-phone', error: null });
};

export const verifyPhone = async (req: Request, res: Response) => {
    const { code } = req.body;
    const userId = (req.session as any).userId;
    
    if (!userId) return res.redirect('/auth/login');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (user && user.phone_verification_code === code) {
        await prisma.user.update({
            where: { id: userId },
            data: { phone_verified: true, phone_verification_code: null }
        });
        res.redirect('/');
    } else {
        res.render('auth/verify-phone', { title: 'Verify Phone', path: '/auth/verify-phone', error: 'Invalid code' });
    }
};

export const forgotPasswordPage = (req: Request, res: Response) => {
    res.render('auth/forgot-password', { title: 'Forgot Password', path: '/auth/forgot-password', message: null, error: null });
};

export const forgotPassword = async (req: Request, res: Response) => {
    const { email } = req.body;
    const user = await userRepo.findByEmail(email);
    
    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.user.update({
            where: { id: user.id },
            data: {
                reset_token: token,
                reset_token_expires: new Date(Date.now() + 3600000) // 1 hour
            }
        });
        
        const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/auth/reset-password/${token}`;
        await comms.sendEmail(email, 'Reset Password', `Click here to reset: ${resetLink}`);
        console.log(`[MOCK EMAIL] Password reset for ${email}: ${resetLink}`);
    }

    res.render('auth/forgot-password', { 
        title: 'Forgot Password', 
        path: '/auth/forgot-password', 
        message: 'If an account exists, a reset link has been sent.',
        error: null
    });
};

export const resetPasswordPage = async (req: Request, res: Response) => {
    const { token } = req.params;
    const user = await prisma.user.findFirst({
        where: {
            reset_token: token,
            reset_token_expires: { gt: new Date() }
        }
    });

    if (!user) {
        return res.render('auth/forgot-password', { title: 'Forgot Password', path: '/auth/forgot-password', message: null, error: 'Invalid or expired token' });
    }

    res.render('auth/reset-password', { title: 'Reset Password', path: '', token, error: null });
};

export const resetPassword = async (req: Request, res: Response) => {
    // ... existing ...
    res.redirect('/auth/login');
};

// --- WebAuthn ---

export const getPasskeyRegistration = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const options = await webAuthnService.getRegistrationOptions(user.id, user.email);
    (req.session as any).currentChallenge = options.challenge;
    
    res.json(options);
};

export const verifyPasskeyRegistration = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const challenge = (req.session as any).currentChallenge;
    
    if (!userId || !challenge) return res.status(400).json({ error: 'Invalid session' });

    try {
        const verified = await webAuthnService.verifyRegistration(userId, req.body, challenge);
        delete (req.session as any).currentChallenge;
        
        if (verified) return res.json({ verified: true });
        res.status(400).json({ error: 'Verification failed' });
    } catch (e: any) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
};

export const getPasskeyAuthOptions = async (req: Request, res: Response) => {
    const options = await webAuthnService.getAuthenticationOptions();
    (req.session as any).currentChallenge = options.challenge;
    res.json(options);
};

export const verifyPasskeyAuth = async (req: Request, res: Response) => {
    const challenge = (req.session as any).currentChallenge;
    if (!challenge) return res.status(400).json({ error: 'Invalid session' });
    const settings = res.locals.settings || {};

    try {
        const userId = await webAuthnService.verifyAuthentication(req.body, challenge);
        if (userId) {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (user) {
                const requireEmailVerification = settings.auth_require_email_verification !== 'false';
                if (requireEmailVerification && !user.email_verified) {
                    if (user.role === 'ADMIN') {
                        await prisma.user.update({
                            where: { id: user.id },
                            data: { email_verified: true, email_verification_token: null }
                        });
                    } else {
                        return res.status(403).json({ error: 'Email verification required' });
                    }
                }
                // Login successful
                (req.session as any).userId = user.id;
                (req.session as any).user = { id: user.id, email: user.email, role: user.role, tier: user.tier };
                (req.session as any).sessionVersion = settings.session_version || '1';
                const idleMinutes = parseInt(settings.session_idle_minutes || '60', 10);
                if (req.session.cookie) {
                    req.session.cookie.maxAge = Math.max(1, idleMinutes) * 60 * 1000;
                }
                delete (req.session as any).currentChallenge;
                return res.json({ verified: true });
            }
        }
        res.status(400).json({ error: 'Verification failed' });
    } catch (e: any) {
        console.error(e);
        res.status(400).json({ error: e.message });
    }
};
