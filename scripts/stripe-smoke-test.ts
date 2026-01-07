import Stripe from 'stripe';
import { PrismaClient, StripeMode, StripePriceStatus } from '@prisma/client';

const prisma = new PrismaClient();

const run = async () => {
  const key = process.env.STRIPE_SECRET_KEY_TEST;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY_TEST is required');
  }

  const planId = process.env.PLAN_ID || null;
  const plan = planId
    ? await prisma.subscriptionPlan.findUnique({ where: { id: planId } })
    : await prisma.subscriptionPlan.findFirst({ orderBy: { level: 'asc' } });

  if (!plan) {
    throw new Error('No subscription plan found');
  }

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  const product = await stripe.products.create({
    name: `${plan.name} Smoke Test`,
    metadata: { plan_id: plan.id, source: 'llm-arena-smoke' }
  }, { idempotencyKey: `smoke-${plan.id}-product` });

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: 9900,
    recurring: { interval: 'month' },
    nickname: 'Smoke Test Monthly'
  }, { idempotencyKey: `smoke-${plan.id}-price` });

  await prisma.subscriptionPlanStripeProduct.upsert({
    where: { plan_id_mode: { plan_id: plan.id, mode: StripeMode.TEST } },
    create: {
      plan_id: plan.id,
      stripe_product_id: product.id,
      mode: StripeMode.TEST,
      active: product.active,
      metadata: product.metadata
    },
    update: {
      stripe_product_id: product.id,
      active: product.active,
      metadata: product.metadata
    }
  });

  await prisma.subscriptionPlanPrice.create({
    data: {
      plan_id: plan.id,
      stripe_price_id: price.id,
      stripe_product_id: product.id,
      nickname: price.nickname || null,
      currency: price.currency.toUpperCase(),
      unit_amount: price.unit_amount || null,
      interval: price.recurring?.interval || null,
      interval_count: price.recurring?.interval_count || null,
      status: StripePriceStatus.ACTIVE,
      is_default: false,
      stripe_active: price.active,
      metadata: price.metadata || null,
      mode: StripeMode.TEST
    }
  });

  console.log('Smoke test created product', product.id, 'price', price.id);
};

run()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
