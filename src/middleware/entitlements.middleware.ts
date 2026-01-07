import { Request, Response, NextFunction } from 'express';
import { resolveEntitlements } from '../services/entitlements.service';

export const attachEntitlements = async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req.session as any).userId as string | undefined;
  const user = (req.session as any).user || null;
  if (!userId) {
    res.locals.entitlements = { resolved: {}, hasEntitlement: () => false };
    return next();
  }

  try {
    const entitlements = await resolveEntitlements({
      userId,
      orgId: user?.org_id || null,
      planId: user?.plan_id || null,
      planTier: user?.tier || null
    });
    (req as any).entitlements = entitlements;
    res.locals.entitlements = entitlements;
  } catch (err) {
    console.error('Failed to resolve entitlements:', err);
    res.locals.entitlements = { resolved: {}, hasEntitlement: () => false };
  }

  return next();
};
