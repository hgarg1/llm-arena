import { Request, Response, NextFunction } from 'express';
import { getPermissionEvaluator } from '../services/rbac.service';
import { logAdminAction } from '../services/audit.service';

export const attachPermissions = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.session as any).userId;
  if (!userId) return next();

  try {
    const evaluator = await getPermissionEvaluator(userId);
    res.locals.permissions = evaluator.effective;
    res.locals.can = evaluator.can;
  } catch (err) {
    console.error('Failed to evaluate permissions:', err);
    res.locals.permissions = [];
    res.locals.can = () => false;
  }

  next();
};

export const requirePermission = (permission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req.session as any).userId;
    if (!userId) return res.status(401).render('errors/401');

    if (typeof res.locals.can === 'function') {
      if (res.locals.can(permission)) return next();
      await logAdminAction(userId, 'access.denied', permission, {
        path: req.originalUrl,
        method: req.method
      });
      return res.status(403).render('errors/403', {
        requiredPermission: permission,
        path: req.originalUrl,
        method: req.method
      });
    }

    const evaluator = await getPermissionEvaluator(userId);
    if (evaluator.can(permission)) return next();
    await logAdminAction(userId, 'access.denied', permission, {
      path: req.originalUrl,
      method: req.method
    });
    return res.status(403).render('errors/403', {
      requiredPermission: permission,
      path: req.originalUrl,
      method: req.method
    });
  };
};
