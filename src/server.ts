import express from 'express';
import path from 'path';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import helmet from 'helmet';
import RedisStore from 'connect-redis';
import csurf from 'csurf';
import routes from './routes';
import * as dotenv from 'dotenv';
import { globalSettingsMiddleware } from './middleware/global.middleware';
import { contentMiddleware } from './middleware/content.middleware';
import { redisConnection } from './config/redis';
import { attachPermissions } from './middleware/rbac.middleware';
import { attachEntitlements } from './middleware/entitlements.middleware';
import { stripeWebhookHandler } from './controllers/stripe.controller';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}

if (isProduction && !process.env.REDIS_URL) {
  throw new Error('REDIS_URL must be set in production');
}

// Middleware
app.set('trust proxy', 1);
app.use(morgan('dev'));
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  store: new RedisStore({ client: redisConnection }),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Global User Middleware
app.use((req, res, next) => {
  res.locals.user = (req.session as any).user || null;
  res.locals.path = req.path; 
  next();
});

// Global Settings & Content
app.use(globalSettingsMiddleware);
app.use(contentMiddleware);
app.use(attachPermissions);
app.use(attachEntitlements);

  app.use((req, res, next) => {
  const settings = res.locals.settings || {};
  const parseList = (value?: string) =>
    (value || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  const allowUnsafeEval = settings.security_csp_allow_unsafe_eval === 'true';

  const csp = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "script-src": ["'self'", "'unsafe-inline'", ...(allowUnsafeEval ? ["'unsafe-eval'"] : []), "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", ...parseList(settings.security_csp_script_src)],
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", ...parseList(settings.security_csp_style_src)],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:", ...parseList(settings.security_csp_font_src)],
        "img-src": ["'self'", "data:", "https:", ...parseList(settings.security_csp_img_src)],
        "connect-src": ["'self'", "https:", ...parseList(settings.security_csp_connect_src)]
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
  if (req.session && idleMinutes > 0 && req.session.cookie) {
    if (!req.session.cookie.maxAge) {
      req.session.cookie.maxAge = idleMinutes * 60 * 1000;
    }
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

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

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

  if (allowed.some(prefix => req.path.startsWith(prefix))) {
    return next();
  }

  return res.status(503).render('errors/503');
});

app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/stripe')) return next();
  return (csurf() as unknown as express.RequestHandler)(req, res, next);
});

app.use((req, res, next) => {
  res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
  next();
});

// Routes
app.use('/', routes);

// 404 Handler
app.use((req, res, next) => {
    res.status(404).render('errors/404');
});

// Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('errors/403');
  }
  console.error(err.stack);
  
  if (err.status === 503) {
      return res.status(503).render('errors/503');
  }
  
  res.status(500).render('errors/500', { errorId: 'ERR-' + Date.now().toString(36).toUpperCase() });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
