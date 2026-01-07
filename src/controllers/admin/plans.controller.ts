import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { logAdminAction } from '../../services/audit.service';

const validatePlanDescriptions = (short: string, long: string) => {
  const errors: string[] = [];
  if (!short || short.trim().length < 15) errors.push('Short description must be at least 15 characters.');
  if (!long || long.trim().length < 40) errors.push('Long description must be at least 40 characters.');
  return errors;
};

const validatePlanFields = (key: string, name: string, currency: string, interval: string, level: number, priceCents: number | null) => {
  const errors: string[] = [];
  if (!/^[a-z0-9_-]{3,}$/.test(key)) errors.push('Key must be 3+ chars, lowercase letters, numbers, dashes, or underscores.');
  if (!name || name.trim().length < 3) errors.push('Name must be at least 3 characters.');
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('Currency must be a 3-letter ISO code (e.g., USD).');
  if (!interval || interval.trim().length < 2) errors.push('Interval must be at least 2 characters.');
  if (!Number.isFinite(level) || level < 1) errors.push('Level must be 1 or higher.');
  if (priceCents !== null && (Number.isNaN(priceCents) || priceCents < 0)) errors.push('Price must be a non-negative integer.');
  return errors;
};

const mapLevelToTier = (level: number) => {
  if (level >= 3) return 'ENTERPRISE';
  if (level >= 2) return 'PRO';
  return 'FREE';
};

export const plansDashboard = async (req: Request, res: Response) => {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: [{ level: 'asc' }, { name: 'asc' }]
  });
  res.render('admin/plans/index', {
    title: 'Subscription Plans',
    path: '/admin/plans',
    plans,
    success: req.query.success,
    error: req.query.error
  });
};

export const createPlan = async (req: Request, res: Response) => {
  const key = (req.body.key || '').trim();
  const name = (req.body.name || '').trim();
  const shortDesc = (req.body.description_short || '').trim();
  const longDesc = (req.body.description_long || '').trim();
  const priceCents = req.body.price_cents ? parseInt(req.body.price_cents, 10) : null;
  const currency = (req.body.currency || 'USD').trim().toUpperCase();
  const interval = (req.body.interval || 'month').trim().toLowerCase();
  const level = req.body.level ? parseInt(req.body.level, 10) : 1;
  const isActive = req.body.is_active === 'on';

  if (!key || !name) return res.redirect('/admin/plans?error=Key and name required');
  const errors = validatePlanDescriptions(shortDesc, longDesc);
  errors.push(...validatePlanFields(key, name, currency, interval, level, priceCents));
  if (errors.length > 0) return res.redirect(`/admin/plans?error=${encodeURIComponent(errors[0])}`);

  try {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        key,
        name,
        description_short: shortDesc,
        description_long: longDesc,
        price_cents: priceCents,
        currency,
        interval,
        level: Math.max(1, level),
        is_active: isActive
      }
    });
    await logAdminAction((req.session as any).userId, 'plan.create', plan.id, { key });
    res.redirect('/admin/plans?success=Plan created');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to create plan');
  }
};

export const updatePlan = async (req: Request, res: Response) => {
  const { id } = req.params;
  const key = (req.body.key || '').trim();
  const name = (req.body.name || '').trim();
  const shortDesc = (req.body.description_short || '').trim();
  const longDesc = (req.body.description_long || '').trim();
  const priceCents = req.body.price_cents ? parseInt(req.body.price_cents, 10) : null;
  const currency = (req.body.currency || 'USD').trim().toUpperCase();
  const interval = (req.body.interval || 'month').trim().toLowerCase();
  const level = req.body.level ? parseInt(req.body.level, 10) : 1;
  const isActive = req.body.is_active === 'on';

  if (!key || !name) return res.redirect('/admin/plans?error=Key and name required');
  const errors = validatePlanDescriptions(shortDesc, longDesc);
  errors.push(...validatePlanFields(key, name, currency, interval, level, priceCents));
  if (errors.length > 0) return res.redirect(`/admin/plans?error=${encodeURIComponent(errors[0])}`);

  try {
    await prisma.subscriptionPlan.update({
      where: { id },
      data: {
        key,
        name,
        description_short: shortDesc,
        description_long: longDesc,
        price_cents: priceCents,
        currency,
        interval,
        level: Math.max(1, level),
        is_active: isActive
      }
    });

    const tier = mapLevelToTier(level);
    await prisma.user.updateMany({
      where: { plan_id: id },
      data: { tier }
    });

    await logAdminAction((req.session as any).userId, 'plan.update', id, { key });
    res.redirect('/admin/plans?success=Plan updated');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to update plan');
  }
};

export const deletePlan = async (req: Request, res: Response) => {
  const { id } = req.params;
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
  if (!plan) return res.redirect('/admin/plans?error=Plan not found');

  await prisma.subscriptionPlan.delete({ where: { id } });
  await logAdminAction((req.session as any).userId, 'plan.delete', id, { key: plan.key });
  res.redirect('/admin/plans?success=Plan deleted');
};
