import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { logAdminAction } from '../../services/audit.service';
import { Prisma, StripeMode, StripePriceStatus } from '@prisma/client';
import { getStripeClient, isStripeId } from '../../services/stripe.service';

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

const parseStripeMode = (value?: string) => {
  return value && value.toUpperCase() === 'LIVE' ? 'LIVE' : 'TEST';
};

const toJsonInput = (value: Prisma.JsonValue | null | undefined): Prisma.InputJsonValue | Prisma.NullTypes.DbNull => {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value;
};

export const plansDashboard = async (req: Request, res: Response) => {
  const [plans, stripeLogs] = await Promise.all([
    prisma.subscriptionPlan.findMany({
      orderBy: [{ level: 'asc' }, { name: 'asc' }],
      include: {
        stripe_products: { orderBy: { created_at: 'desc' } },
        prices: { orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }] }
      }
    }),
    prisma.adminAuditLog.findMany({
      where: { action: { startsWith: 'plan.stripe' } },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: { admin: { select: { email: true } } }
    })
  ]);
  res.render('admin/plans/index', {
    title: 'Subscription Plans',
    path: '/admin/plans',
    plans,
    stripeLogs,
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

export const updateStripeProduct = async (req: Request, res: Response) => {
  const { id } = req.params;
  const stripeProductId = (req.body.stripe_product_id || '').trim();
  const stripeActive = req.body.stripe_product_active === 'on';
  const mode = parseStripeMode(req.body.mode);

  if (stripeProductId && !isStripeId(stripeProductId, 'prod_')) {
    return res.redirect('/admin/plans?error=Invalid Stripe Product ID');
  }

  try {
    if (!stripeProductId) {
      await prisma.subscriptionPlanStripeProduct.deleteMany({
        where: { plan_id: id, mode: mode as StripeMode }
      });
      await logAdminAction((req.session as any).userId, 'plan.stripe_product.clear', id, { mode });
      return res.redirect('/admin/plans?success=Stripe product cleared');
    }
    let metadata: Prisma.JsonValue | null = null;
    let active: boolean | null = stripeProductId ? stripeActive : null;
    const stripe = getStripeClient(mode);
    if (stripe && stripeProductId) {
      const product = await stripe.products.retrieve(stripeProductId);
      metadata = (product.metadata || null) as Prisma.JsonValue | null;
      active = product.active;
    }

    await prisma.$transaction(async tx => {
      await tx.subscriptionPlanStripeProduct.upsert({
        where: { plan_id_mode: { plan_id: id, mode: mode as StripeMode } },
        create: {
          plan_id: id,
          stripe_product_id: stripeProductId,
          mode: mode as StripeMode,
          active: stripeProductId ? (active ?? true) : false,
          metadata: stripeProductId ? toJsonInput(metadata) : Prisma.DbNull,
          created_by: (req.session as any).userId
        },
        update: {
          stripe_product_id: stripeProductId,
          active: stripeProductId ? (active ?? true) : false,
          metadata: stripeProductId ? toJsonInput(metadata) : Prisma.DbNull
        }
      });
    });
    await logAdminAction((req.session as any).userId, 'plan.stripe_product.update', id, { stripe_product_id: stripeProductId });
    res.redirect('/admin/plans?success=Stripe product updated');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to update Stripe product');
  }
};

export const addStripePrice = async (req: Request, res: Response) => {
  const { id } = req.params;
  const stripePriceId = (req.body.stripe_price_id || '').trim();
  const nickname = (req.body.nickname || '').trim() || null;
  const status = (req.body.status || 'ACTIVE').toUpperCase();
  const isDefault = req.body.is_default === 'on';
  const mode = parseStripeMode(req.body.mode);

  if (!stripePriceId || !isStripeId(stripePriceId, 'price_')) {
    return res.redirect('/admin/plans?error=Invalid Stripe Price ID');
  }
  if (!['ACTIVE', 'INACTIVE', 'LEGACY'].includes(status)) {
    return res.redirect('/admin/plans?error=Invalid price status');
  }

  try {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!plan) return res.redirect('/admin/plans?error=Plan not found');

    let priceData: {
      stripe_product_id?: string | null;
      currency?: string | null;
      unit_amount?: number | null;
      interval?: string | null;
      interval_count?: number | null;
      stripe_active?: boolean | null;
      metadata?: Prisma.JsonValue | null;
    } = {};
    const stripe = getStripeClient(mode);
    if (stripe) {
      const price = await stripe.prices.retrieve(stripePriceId);
      priceData = {
        stripe_product_id: typeof price.product === 'string' ? price.product : price.product?.id,
        currency: price.currency ? price.currency.toUpperCase() : null,
        unit_amount: typeof price.unit_amount === 'number' ? price.unit_amount : null,
        interval: price.recurring?.interval || null,
        interval_count: price.recurring?.interval_count || null,
        stripe_active: price.active,
        metadata: (price.metadata || null) as Prisma.JsonValue | null
      };
      const planProduct = await prisma.subscriptionPlanStripeProduct.findUnique({
        where: { plan_id_mode: { plan_id: id, mode: mode as StripeMode } }
      });
      if (planProduct?.stripe_product_id && priceData.stripe_product_id && planProduct.stripe_product_id !== priceData.stripe_product_id) {
        return res.redirect('/admin/plans?error=Price does not belong to plan product');
      }
      if (!planProduct && priceData.stripe_product_id) {
        await prisma.subscriptionPlanStripeProduct.create({
          data: {
            plan_id: id,
            stripe_product_id: priceData.stripe_product_id,
            mode: mode as StripeMode,
            active: true,
            metadata: Prisma.DbNull,
            created_by: (req.session as any).userId
          }
        });
      }
    }

    await prisma.$transaction(async tx => {
      if (isDefault) {
        await tx.subscriptionPlanPrice.updateMany({
          where: { plan_id: id, is_default: true, mode: mode as StripeMode },
          data: { is_default: false }
        });
      }
      await tx.subscriptionPlanPrice.create({
        data: {
          plan_id: id,
          stripe_price_id: stripePriceId,
          stripe_product_id: priceData.stripe_product_id,
          nickname,
          currency: priceData.currency,
          unit_amount: priceData.unit_amount,
          interval: priceData.interval,
          interval_count: priceData.interval_count,
          status: (status as StripePriceStatus) || StripePriceStatus.ACTIVE,
          is_default: isDefault,
          stripe_active: typeof priceData.stripe_active === 'boolean' ? priceData.stripe_active : null,
          metadata: toJsonInput(priceData.metadata ?? null),
          mode: mode as StripeMode,
          created_by: (req.session as any).userId
        }
      });
    });

    await logAdminAction((req.session as any).userId, 'plan.stripe_price.add', id, { stripe_price_id: stripePriceId });
    res.redirect('/admin/plans?success=Stripe price added');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to add Stripe price');
  }
};

export const updateStripePrice = async (req: Request, res: Response) => {
  const { id, priceId } = req.params;
  const status = (req.body.status || 'ACTIVE').toUpperCase();
  const isDefault = req.body.is_default === 'on';
  const nickname = (req.body.nickname || '').trim() || null;
  const mode = parseStripeMode(req.body.mode);

  if (!['ACTIVE', 'INACTIVE', 'LEGACY'].includes(status)) {
    return res.redirect('/admin/plans?error=Invalid price status');
  }

  try {
    const existing = await prisma.subscriptionPlanPrice.findUnique({ where: { id: priceId } });
    if (!existing || existing.plan_id !== id) {
      return res.redirect('/admin/plans?error=Price not found for plan');
    }
    await prisma.$transaction(async tx => {
      if (isDefault) {
        await tx.subscriptionPlanPrice.updateMany({
          where: { plan_id: id, is_default: true, mode: existing.mode },
          data: { is_default: false }
        });
      }
      await tx.subscriptionPlanPrice.update({
        where: { id: priceId },
        data: {
          status: status as StripePriceStatus,
          is_default: isDefault,
          nickname
        }
      });
    });
    await logAdminAction((req.session as any).userId, 'plan.stripe_price.update', id, { price_id: priceId, status });
    res.redirect('/admin/plans?success=Stripe price updated');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to update Stripe price');
  }
};

export const validateStripeId = async (req: Request, res: Response) => {
  const type = String(req.body.type || '').trim();
  const value = String(req.body.value || '').trim();
  const mode = parseStripeMode(req.body.mode);
  if (!['price', 'product'].includes(type)) return res.json({ ok: false, error: 'Invalid type' });

  const prefix = type === 'price' ? 'price_' : 'prod_';
  if (!isStripeId(value, prefix)) return res.json({ ok: false, error: 'Invalid ID format' });

  const stripe = getStripeClient(mode);
  if (!stripe) return res.json({ ok: true, warning: 'Stripe API unavailable, format only' });

  try {
    if (type === 'price') {
      const price = await stripe.prices.retrieve(value);
      return res.json({ ok: true, data: { id: price.id, active: price.active, currency: price.currency } });
    }
    const product = await stripe.products.retrieve(value);
    return res.json({ ok: true, data: { id: product.id, active: product.active, name: product.name } });
  } catch (err) {
    return res.json({ ok: false, error: 'Stripe lookup failed' });
  }
};

export const createStripeProductAndPrice = async (req: Request, res: Response) => {
  const { id } = req.params;
  const name = (req.body.name || '').trim();
  const currency = (req.body.currency || '').trim().toLowerCase();
  const amount = req.body.unit_amount ? parseInt(req.body.unit_amount, 10) : NaN;
  const interval = (req.body.interval || '').trim().toLowerCase();
  const intervalCount = req.body.interval_count ? parseInt(req.body.interval_count, 10) : 1;
  const nickname = (req.body.nickname || '').trim() || null;
  const mode = parseStripeMode(req.body.mode);

  if (!name || name.length < 3) return res.redirect('/admin/plans?error=Plan name required');
  if (!Number.isFinite(amount) || amount < 50) return res.redirect('/admin/plans?error=Amount must be at least 50 cents');
  if (!['month', 'year'].includes(interval)) return res.redirect('/admin/plans?error=Interval must be month or year');
  if (!/^[a-z]{3}$/.test(currency)) return res.redirect('/admin/plans?error=Currency must be a 3-letter code');

  try {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!plan) return res.redirect('/admin/plans?error=Plan not found');

    const stripe = getStripeClient(mode);
    if (!stripe) return res.redirect('/admin/plans?error=Stripe is not configured');

    let product = await prisma.subscriptionPlanStripeProduct.findUnique({
      where: { plan_id_mode: { plan_id: id, mode: mode as StripeMode } }
    });

    if (!product) {
      const stripeProduct = await stripe.products.create({
        name,
        metadata: { plan_id: id, source: 'llm-arena-admin' }
      }, { idempotencyKey: `plan-${id}-${mode}-product` });

      product = await prisma.subscriptionPlanStripeProduct.create({
        data: {
          plan_id: id,
          stripe_product_id: stripeProduct.id,
          mode: mode as StripeMode,
          active: stripeProduct.active,
          metadata: toJsonInput((stripeProduct.metadata || null) as Prisma.JsonValue | null),
          created_by: (req.session as any).userId
        }
      });
      await logAdminAction((req.session as any).userId, 'plan.stripe_product.create', id, { stripe_product_id: stripeProduct.id, mode });
    }

    const stripePrice = await stripe.prices.create({
      product: product.stripe_product_id,
      currency,
      unit_amount: amount,
      nickname: nickname || undefined,
      recurring: { interval: interval as any, interval_count: intervalCount }
    }, { idempotencyKey: `plan-${id}-${mode}-price-${amount}-${currency}-${interval}-${intervalCount}-${nickname || 'default'}` });

    await prisma.$transaction(async tx => {
      if (req.body.is_default === 'on') {
        await tx.subscriptionPlanPrice.updateMany({
          where: { plan_id: id, is_default: true, mode: mode as StripeMode },
          data: { is_default: false }
        });
      }
      await tx.subscriptionPlanPrice.create({
        data: {
          plan_id: id,
          stripe_price_id: stripePrice.id,
          stripe_product_id: product?.stripe_product_id,
          nickname,
          currency: stripePrice.currency ? stripePrice.currency.toUpperCase() : null,
          unit_amount: stripePrice.unit_amount || null,
          interval: stripePrice.recurring?.interval || null,
          interval_count: stripePrice.recurring?.interval_count || null,
          status: StripePriceStatus.ACTIVE,
          is_default: req.body.is_default === 'on',
          stripe_active: stripePrice.active,
          metadata: toJsonInput((stripePrice.metadata || null) as Prisma.JsonValue | null),
          mode: mode as StripeMode,
          created_by: (req.session as any).userId
        }
      });
    });

    await logAdminAction((req.session as any).userId, 'plan.stripe_price.create', id, { stripe_price_id: stripePrice.id, mode });
    res.redirect('/admin/plans?success=Stripe product and price created');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to create Stripe product/price');
  }
};

export const createStripePrice = async (req: Request, res: Response) => {
  const { id } = req.params;
  const currency = (req.body.currency || '').trim().toLowerCase();
  const amount = req.body.unit_amount ? parseInt(req.body.unit_amount, 10) : NaN;
  const interval = (req.body.interval || '').trim().toLowerCase();
  const intervalCount = req.body.interval_count ? parseInt(req.body.interval_count, 10) : 1;
  const nickname = (req.body.nickname || '').trim() || null;
  const mode = parseStripeMode(req.body.mode);

  if (!Number.isFinite(amount) || amount < 50) return res.redirect('/admin/plans?error=Amount must be at least 50 cents');
  if (!['month', 'year'].includes(interval)) return res.redirect('/admin/plans?error=Interval must be month or year');
  if (!/^[a-z]{3}$/.test(currency)) return res.redirect('/admin/plans?error=Currency must be a 3-letter code');

  try {
    const product = await prisma.subscriptionPlanStripeProduct.findUnique({
      where: { plan_id_mode: { plan_id: id, mode: mode as StripeMode } }
    });
    if (!product) return res.redirect('/admin/plans?error=No Stripe product linked for this plan and mode');

    const stripe = getStripeClient(mode);
    if (!stripe) return res.redirect('/admin/plans?error=Stripe is not configured');

    const stripePrice = await stripe.prices.create({
      product: product.stripe_product_id,
      currency,
      unit_amount: amount,
      nickname: nickname || undefined,
      recurring: { interval: interval as any, interval_count: intervalCount }
    }, { idempotencyKey: `plan-${id}-${mode}-price-${amount}-${currency}-${interval}-${intervalCount}-${nickname || 'default'}` });

    await prisma.$transaction(async tx => {
      if (req.body.is_default === 'on') {
        await tx.subscriptionPlanPrice.updateMany({
          where: { plan_id: id, is_default: true, mode: mode as StripeMode },
          data: { is_default: false }
        });
      }
      await tx.subscriptionPlanPrice.create({
        data: {
          plan_id: id,
          stripe_price_id: stripePrice.id,
          stripe_product_id: product.stripe_product_id,
          nickname,
          currency: stripePrice.currency ? stripePrice.currency.toUpperCase() : null,
          unit_amount: stripePrice.unit_amount || null,
          interval: stripePrice.recurring?.interval || null,
          interval_count: stripePrice.recurring?.interval_count || null,
          status: StripePriceStatus.ACTIVE,
          is_default: req.body.is_default === 'on',
          stripe_active: stripePrice.active,
          metadata: toJsonInput((stripePrice.metadata || null) as Prisma.JsonValue | null),
          mode: mode as StripeMode,
          created_by: (req.session as any).userId
        }
      });
    });

    await logAdminAction((req.session as any).userId, 'plan.stripe_price.create', id, { stripe_price_id: stripePrice.id, mode });
    res.redirect('/admin/plans?success=Stripe price created');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to create Stripe price');
  }
};

export const syncStripePlan = async (req: Request, res: Response) => {
  const { id } = req.params;
  const mode = parseStripeMode(req.body.mode);
  try {
    const product = await prisma.subscriptionPlanStripeProduct.findUnique({
      where: { plan_id_mode: { plan_id: id, mode: mode as StripeMode } }
    });
    if (!product) return res.redirect('/admin/plans?error=No Stripe product linked for this plan and mode');

    const stripe = getStripeClient(mode);
    if (!stripe) return res.redirect('/admin/plans?error=Stripe is not configured');

    const stripeProduct = await stripe.products.retrieve(product.stripe_product_id);
    await prisma.subscriptionPlanStripeProduct.update({
      where: { id: product.id },
      data: {
        active: stripeProduct.active,
        metadata: toJsonInput((stripeProduct.metadata || null) as Prisma.JsonValue | null)
      }
    });

    const priceList = await stripe.prices.list({ product: product.stripe_product_id, limit: 100 });
    for (const price of priceList.data) {
      const existing = await prisma.subscriptionPlanPrice.findUnique({ where: { stripe_price_id: price.id } });
      const nextStatus = existing?.status === StripePriceStatus.LEGACY
        ? StripePriceStatus.LEGACY
        : (price.active ? StripePriceStatus.ACTIVE : StripePriceStatus.INACTIVE);
      await prisma.subscriptionPlanPrice.upsert({
        where: { stripe_price_id: price.id },
        create: {
          plan_id: id,
          stripe_price_id: price.id,
          stripe_product_id: product.stripe_product_id,
          nickname: price.nickname || null,
          currency: price.currency ? price.currency.toUpperCase() : null,
          unit_amount: price.unit_amount || null,
          interval: price.recurring?.interval || null,
          interval_count: price.recurring?.interval_count || null,
          status: nextStatus,
          is_default: false,
          stripe_active: price.active,
          metadata: price.metadata || null,
          mode: mode as StripeMode,
          created_by: (req.session as any).userId
        },
        update: {
          nickname: price.nickname || null,
          currency: price.currency ? price.currency.toUpperCase() : null,
          unit_amount: price.unit_amount || null,
          interval: price.recurring?.interval || null,
          interval_count: price.recurring?.interval_count || null,
          stripe_active: price.active,
          metadata: price.metadata || null,
          status: nextStatus
        }
      });
    }

    await logAdminAction((req.session as any).userId, 'plan.stripe.sync', id, { mode });
    res.redirect('/admin/plans?success=Stripe sync completed');
  } catch (err) {
    res.redirect('/admin/plans?error=Failed to sync from Stripe');
  }
};
