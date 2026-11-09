import express from 'express';
import path from 'path';
import fs from 'fs';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import helmet from 'helmet';
import RedisStore from 'connect-redis';
import csurf from 'csurf';
import { Server } from 'socket.io';
import routes from './routes';
import * as dotenv from 'dotenv';
import { globalSettingsMiddleware } from './middleware/global.middleware';
import { contentMiddleware } from './middleware/content.middleware';
import { redisConnection } from './config/redis';
import { attachPermissions } from './middleware/rbac.middleware';
import { attachEntitlements } from './middleware/entitlements.middleware';
import { stripeWebhookHandler } from './controllers/stripe.controller';
import { prisma as db } from './config/db';
import { ensureDefaultGamesOnce } from './services/default-games.service';
import { PrismaSessionStore } from './config/session-store';
import { createSessionStatusHandler } from './middleware/session-status';
import { settingsService } from './services/settings.service';
import { getCanonicalHost, getSiteUrl, isDatabaseConfigured, isRedisSessionEnabled, isRealtimeEnabled } from './config/runtime';

dotenv.config();

const runtimeDebug = process.env.RUNTIME_DEBUG === 'true';

const resolveProjectPath = (...segments: string[]) => {
  const candidates = [
    path.join(process.cwd(), ...segments),
    path.join(__dirname, '..', ...segments),
    path.join(__dirname, '..', '..', ...segments)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
};

const attachRealtimeHandlers = (io: Server, sessionMiddleware: express.RequestHandler) => {
  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const req = socket.request as any;
    const session = req.session;

    if (session && session.userId) {
      socket.join(`user:${session.userId}`);

      socket.on('join_channel', (channelId) => {
        socket.join(`channel:${channelId}`);
      });

      socket.on('leave_channel', (channelId) => {
        socket.leave(`channel:${channelId}`);
      });

      socket.on('typing', ({ channelId, isTyping }) => {
        socket.to(`channel:${channelId}`).emit('typing', {
          channelId,
          userId: session.userId,
          userName: session.user?.name || session.user?.email || 'User',
          isTyping
        });
      });

      socket.on('read_message', ({ channelId, messageId }) => {
        socket.to(`channel:${channelId}`).emit('message_read', {
          channelId,
          messageId,
          userId: session.userId,
          userAvatar: session.user?.avatar_url
        });
      });
    }
  });
};

export const createApp = (options?: { io?: Server | null }) => {
  const app = express();
  const io = options?.io ?? null;
  const realtimeEnabled = Boolean(io) && isRealtimeEnabled();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET must be set in production');
  }

  // On serverless there is no long-lived server.ts to seed the built-in games, so do it once per cold start.
  // It is idempotent and cheap; a failure must not stop the site from serving.
  if (process.env.VERCEL && isDatabaseConfigured()) {
    ensureDefaultGamesOnce().catch(err => console.error('Failed to seed default games:', err));
  }

  app.set('trust proxy', 1);
  app.set('io', realtimeEnabled ? io : null);

  app.use(morgan('dev'));
  app.use((req, res, next) => {
    const siteUrl = getSiteUrl();
    res.locals.canonicalSiteUrl = siteUrl;
    res.locals.requestOriginalUrl = req.originalUrl;
    res.locals.ogImageVersion =
      process.env.OG_IMAGE_VERSION ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_DEPLOYMENT_ID ||
      '20260403-preview-fix';
    next();
  });
  app.use((req, res, next) => {
    if (!isProduction || !['GET', 'HEAD'].includes(req.method)) {
      return next();
    }

    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const normalizedHost = host.replace(/:\d+$/, '');
    const canonicalHost = getCanonicalHost();
    const acceptsHtml = req.accepts(['html', 'json']) === 'html';

    if (!acceptsHtml || !normalizedHost || normalizedHost === canonicalHost || normalizedHost === 'localhost' || normalizedHost === '127.0.0.1') {
      return next();
    }

    return res.redirect(301, `${getSiteUrl()}${req.originalUrl}`);
  });
  app.use((req, res, next) => {
    if (runtimeDebug) {
      console.log('[runtime] request:start', {
        method: req.method,
        path: req.path,
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        hasRedisUrl: Boolean(process.env.REDIS_URL),
        databaseEnabled: isDatabaseConfigured(),
        redisSessionEnabled: isRedisSessionEnabled(),
        realtimeEnabled
      });
    }
    next();
  });
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  const sessionOptions: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    proxy: isProduction,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: 'lax'
    }
  };

  // The store is always explicit so the session-status endpoint can read it directly (see middleware/session-status.ts).
  let sessionStore: session.Store;
  if (isRedisSessionEnabled()) {
    sessionStore = new RedisStore({ client: redisConnection });
  } else if (isDatabaseConfigured() && (process.env.VERCEL || process.env.SESSION_STORE === 'postgres')) {
    // Serverless instances cannot share an in-memory store, so keep sessions in the database.
    sessionStore = new PrismaSessionStore();
  } else {
    sessionStore = new session.MemoryStore();
  }
  sessionOptions.store = sessionStore;

  // Read-only login status for the browser's expiry watcher. Mounted before the session middleware on purpose:
  // anything that passes through express-session would extend (touch) the very session it is asking about.
  app.get('/auth/session', createSessionStatusHandler({
    secret: sessionOptions.secret as string,
    store: sessionStore,
    getSessionVersion: async () => (await settingsService.getAll()).session_version || '1'
  }));

  const sessionMiddleware = session(sessionOptions);

  app.use(sessionMiddleware);

  if (realtimeEnabled && io) {
    attachRealtimeHandlers(io, sessionMiddleware);
  }

  app.use(async (req, res, next) => {
    const userId = (req.session as any).userId;
    if (userId) {
      try {
        const user = await db.user.findUnique({ where: { id: userId } });
        res.locals.user = user;
      } catch (e) {
        console.error('Failed to fetch user', e);
        res.locals.user = null;
      }
    } else {
      res.locals.user = null;
    }
    res.locals.path = req.path;
    res.locals.realtimeEnabled = realtimeEnabled;
    res.locals.databaseEnabled = isDatabaseConfigured();
    if (runtimeDebug) {
      console.log('[runtime] middleware:user', {
        path: req.path,
        hasUser: Boolean(res.locals.user),
        databaseEnabled: res.locals.databaseEnabled
      });
    }
    next();
  });

  app.use(async (req, res, next) => {
    try {
      await globalSettingsMiddleware(req, res, next);
      if (runtimeDebug) console.log('[runtime] middleware:settings:ok', { path: req.path });
    } catch (error) {
      console.error('[runtime] middleware:settings:fail', error);
      next(error);
    }
  });
  app.use(async (req, res, next) => {
    try {
      await contentMiddleware(req, res, next);
      if (runtimeDebug) console.log('[runtime] middleware:content:ok', { path: req.path });
    } catch (error) {
      console.error('[runtime] middleware:content:fail', error);
      next(error);
    }
  });
  app.use(async (req, res, next) => {
    try {
      await attachPermissions(req, res, next);
      if (runtimeDebug) console.log('[runtime] middleware:permissions:ok', { path: req.path });
    } catch (error) {
      console.error('[runtime] middleware:permissions:fail', error);
      next(error);
    }
  });
  app.use(async (req, res, next) => {
    try {
      await attachEntitlements(req, res, next);
      if (runtimeDebug) console.log('[runtime] middleware:entitlements:ok', { path: req.path });
    } catch (error) {
      console.error('[runtime] middleware:entitlements:fail', error);
      next(error);
    }
  });

  app.use((req, res, next) => {
    if (!isDatabaseConfigured()) {
      const readOnlyPrefixes = [
        '/',
        '/how-it-works',
        '/benchmarks',
        '/methodology',
        '/use-cases',
        '/about',
        '/docs',
        '/terms',
        '/privacy',
        '/investors',
        '/matches',
        '/models',
        '/auth/login',
        '/auth/signup',
        '/auth/forgot-password'
      ];
      const isReadOnlyGet = req.method === 'GET' && readOnlyPrefixes.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`));
      if (!isReadOnlyGet) {
        return res.status(503).render('errors/503');
      }
    }

    const settings = res.locals.settings || {};
    const parseList = (value?: string) =>
      (value || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const allowUnsafeEval = settings.security_csp_allow_unsafe_eval === 'true';

    const csp = helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'script-src': ["'self'", "'unsafe-inline'", ...(allowUnsafeEval ? ["'unsafe-eval'"] : []), 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', ...parseList(settings.security_csp_script_src)],
          'script-src-attr': ["'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', ...parseList(settings.security_csp_style_src)],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:', ...parseList(settings.security_csp_font_src)],
          'img-src': ["'self'", 'data:', 'https:', ...parseList(settings.security_csp_img_src)],
          'connect-src': ["'self'", 'https:', 'ws:', 'wss:', ...parseList(settings.security_csp_connect_src)]
        }
      }
    });

    csp(req, res, () => {
      if (isProduction && settings.security_hsts_enabled !== 'false') {
        const maxAge = parseInt(settings.security_hsts_max_age || '15552000', 10);
        return helmet.hsts({ maxAge, includeSubDomains: true, preload: true })(req, res, next);
      }
      next();
    });
  });

  app.use((req, res, next) => {
    const settings = res.locals.settings || {};
    const idleMinutes = parseInt(settings.session_idle_minutes || '60', 10);
    if (req.session && idleMinutes > 0 && req.session.cookie && !req.session.cookie.maxAge) {
      req.session.cookie.maxAge = idleMinutes * 60 * 1000;
    }
    const version = settings.session_version || '1';
    if (req.session && (req.session as any).userId) {
      const currentVersion = (req.session as any).sessionVersion;
      if (!currentVersion || currentVersion !== version) {
        return req.session.destroy(() => res.redirect('/auth/login'));
      }
    }
    next();
  });

  app.set('view engine', 'ejs');
  app.set('views', resolveProjectPath('views'));

  app.use(express.static(resolveProjectPath('public')));

  app.use((req, res, next) => {
    const settings = res.locals.settings || {};
    const maintenance = settings.maintenance_mode === 'true';
    if (!maintenance) return next();

    const allowed = [
      '/admin',
      '/auth',
      '/css',
      '/img',
      '/js',
      '/uploads',
      '/manifest.json',
      '/favicon'
    ];

    if (allowed.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }

    return res.status(503).render('errors/503');
  });

  app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/stripe') || req.path === '/auth/logout') return next();
    return (csurf() as unknown as express.RequestHandler)(req, res, next);
  });

  app.use((req, res, next) => {
    res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
    next();
  });

  app.use('/', routes);

  app.use((req, res) => {
    res.status(404).render('errors/404');
  });

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[runtime] error-handler', {
      path: req.path,
      method: req.method,
      message: err?.message,
      stack: err?.stack
    });
    if (err.code === 'EBADCSRFTOKEN') {
      return res.status(403).render('errors/403');
    }
    console.error(err.stack);

    if (err.status === 503) {
      return res.status(503).render('errors/503');
    }

    res.status(500).render('errors/500', { errorId: 'ERR-' + Date.now().toString(36).toUpperCase() });
  });

  return app;
};
