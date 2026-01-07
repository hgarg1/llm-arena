import { Request, Response, NextFunction } from 'express';
import { redisConnection } from '../config/redis';
import { prisma } from '../config/db';

const getInt = (value: string | undefined, fallback: number) => {
  const parsed = parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const loginRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const settings = res.locals.settings || {};
  const windowSeconds = getInt(settings.auth_login_window_minutes, 15) * 60;
  const maxAttempts = getInt(settings.auth_login_attempts, 10);
  const ip = req.ip || 'unknown';
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
  const key = `rl:login:${ip}:${email}`;

  try {
    const attempts = await redisConnection.incr(key);
    if (attempts === 1) {
      await redisConnection.expire(key, windowSeconds);
    }

    if (attempts > maxAttempts) {
      return res.status(429).render('auth/login', {
        title: 'Sign In',
        path: '/auth/login',
        error: 'Too many login attempts. Please try again later.'
      });
    }
  } catch (err) {
    console.error('Login rate limiter failed:', err);
  }

  next();
};

export const matchCreateRateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.session as any).userId;
  if (!userId) return next();
  const role = (req.session as any).user?.role;
  if (role === 'ADMIN') return next();

  const settings = res.locals.settings || {};
  let tier = (req.session as any).user?.tier;
  if (!tier) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });
    tier = user?.tier || 'FREE';
  }

  const limitMap: Record<string, string> = {
    FREE: settings.limit_matches_per_day_free,
    PRO: settings.limit_matches_per_day_pro,
    ENTERPRISE: settings.limit_matches_per_day_enterprise
  };
  const limit = getInt(limitMap[tier] || '0', 0);
  if (!limit || limit <= 0) return next();

  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:matches:${userId}:${today}`;

  try {
    const count = await redisConnection.incr(key);
    if (count === 1) {
      await redisConnection.expire(key, 24 * 60 * 60);
    }
    if (count > limit) {
      return res.status(429).render('errors/403', { title: 'Limit Reached' });
    }
  } catch (err) {
    console.error('Match rate limiter failed:', err);
  }

  next();
};
