import { Request, Response } from 'express';
import Stripe from 'stripe';
import { prisma } from '../config/db';
import { StripeMode } from '@prisma/client';

const getStripe = (mode: StripeMode) => {
  const key = mode === 'LIVE' ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY_TEST;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2023-10-16' });
};

const resolveTarget = (subscription: Stripe.Subscription) => {
  const metadata = subscription.metadata || {};
  const targetType = (metadata.target_type || '').toUpperCase();
  if (targetType === 'ORG' && metadata.org_id) {
    return { type: 'ORG', id: metadata.org_id as string };
  }
  if (metadata.user_id) {
    return { type: 'USER', id: metadata.user_id as string };
  }
  return { type: 'USER', id: metadata.target_id || subscription.customer as string };
};

const upsertSubscription = async (subscription: Stripe.Subscription, mode: StripeMode) => {
  const item = subscription.items.data[0];
  const priceId = item?.price?.id || null;
  const productId = item?.price?.product && typeof item.price.product === 'string'
    ? item.price.product
    : (item?.price?.product as any)?.id || null;

  const planPrice = priceId
    ? await prisma.subscriptionPlanPrice.findFirst({ where: { stripe_price_id: priceId, mode } })
    : null;
  const planId = planPrice?.plan_id || (subscription.metadata.plan_id as string | undefined) || null;
  const target = resolveTarget(subscription);
  const plan = planId ? await prisma.subscriptionPlan.findUnique({ where: { id: planId } }) : null;
  const mapLevelToTier = (level: number) => {
    if (level >= 3) return 'ENTERPRISE';
    if (level >= 2) return 'PRO';
    return 'FREE';
  };

  if (target.type === 'USER' && target.id) {
    await prisma.user.updateMany({
      where: { id: target.id },
      data: { stripe_customer_id: subscription.customer as string }
    });
  }
  if (target.type === 'ORG' && target.id) {
    await prisma.organization.updateMany({
      where: { id: target.id },
      data: { stripe_customer_id: subscription.customer as string }
    });
  }

  await prisma.stripeSubscription.upsert({
    where: { stripe_subscription_id: subscription.id },
    create: {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer as string,
      stripe_mode: mode,
      status: subscription.status,
      plan_id: planId,
      price_id: priceId,
      product_id: productId,
      target_type: target.type as any,
      target_id: target.id || (subscription.customer as string),
      current_period_start: subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      quantity: item?.quantity || null,
      raw: subscription as any
    },
    update: {
      stripe_customer_id: subscription.customer as string,
      stripe_mode: mode,
      status: subscription.status,
      plan_id: planId,
      price_id: priceId,
      product_id: productId,
      target_type: target.type as any,
      target_id: target.id || (subscription.customer as string),
      current_period_start: subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      quantity: item?.quantity || null,
      raw: subscription as any
    }
  });

  if (plan && (subscription.status === 'active' || subscription.status === 'trialing')) {
    if (target.type === 'USER') {
      await prisma.user.updateMany({
        where: { id: target.id },
        data: { plan_id: plan.id, tier: mapLevelToTier(plan.level) as any }
      });
    }
    if (target.type === 'ORG') {
      await prisma.organization.updateMany({
        where: { id: target.id },
        data: { plan_id: plan.id }
      });
    }
  }

  if (target.type === 'USER' && ['canceled', 'unpaid', 'incomplete_expired'].includes(subscription.status)) {
    await prisma.user.updateMany({
      where: { id: target.id },
      data: { plan_id: null, tier: 'FREE' as any }
    });
  }
};

export const stripeWebhookHandler = async (req: Request, res: Response) => {
  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (!liveSecret && !testSecret) {
    return res.status(400).send('Stripe not configured');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(400).send('Missing signature');
  }

  let event: Stripe.Event;
  let mode: StripeMode = 'TEST';
  try {
    if (liveSecret) {
      const stripe = getStripe('LIVE');
      if (stripe) {
        event = stripe.webhooks.constructEvent(req.body, signature, liveSecret);
        mode = 'LIVE';
      } else {
        throw new Error('Stripe live key not configured');
      }
    } else if (testSecret) {
      const stripe = getStripe('TEST');
      if (!stripe) throw new Error('Stripe test key not configured');
      event = stripe.webhooks.constructEvent(req.body, signature, testSecret);
      mode = 'TEST';
    } else {
      throw new Error('Stripe webhooks not configured');
    }
  } catch (err: any) {
    try {
      if (testSecret) {
        const stripe = getStripe('TEST');
        if (!stripe) throw new Error('Stripe test key not configured');
        event = stripe.webhooks.constructEvent(req.body, signature, testSecret);
        mode = 'TEST';
      } else {
        throw err;
      }
    } catch (inner: any) {
      return res.status(400).send(`Webhook error: ${inner.message}`);
    }
  }

  try {
    if (event.type.startsWith('customer.subscription.')) {
      const subscription = event.data.object as Stripe.Subscription;
      await upsertSubscription(subscription, mode);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).send('Webhook handler failed');
  }
};
