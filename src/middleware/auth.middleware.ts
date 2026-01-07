import { Request, Response, NextFunction } from 'express';
import { logAdminAction } from '../services/audit.service';

export const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  if ((req.session as any).userId) {
    return next();
  }
  res.status(401).render('errors/401');
};

export const isAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = (req.session as any).user;
    if (!(req.session as any).userId) {
        return res.status(401).render('errors/401');
    }
    if (user && user.role === 'ADMIN') {
        return next();
    }
    // If not logged in, they should hit 401 first, but if they are logged in as USER:
    logAdminAction((req.session as any).userId, 'access.denied', 'admin.access', {
        path: req.originalUrl,
        method: req.method,
        reason: 'role'
    });
    res.status(403).render('errors/403', {
        requiredPermission: 'admin.access',
        path: req.originalUrl,
        method: req.method
    });
};

export const requirePasskeyEnabled = (req: Request, res: Response, next: NextFunction) => {
    const settings = res.locals.settings || {};
    if (settings.auth_passkey_enabled === 'false') {
        const userId = (req.session as any).userId;
        if (userId) {
            logAdminAction(userId, 'access.denied', 'auth.passkey', {
                path: req.originalUrl,
                method: req.method,
                reason: 'passkey_disabled'
            });
        }
        return res.status(403).render('errors/403', {
            requiredPermission: 'auth.passkey',
            path: req.originalUrl,
            method: req.method
        });
    }
    next();
};
