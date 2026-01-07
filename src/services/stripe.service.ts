import Stripe from 'stripe';

let stripeTestClient: Stripe | null = null;
let stripeLiveClient: Stripe | null = null;

export const getStripeClient = (mode?: 'TEST' | 'LIVE') => {
  const testKey = process.env.STRIPE_SECRET_KEY_TEST;
  const liveKey = process.env.STRIPE_SECRET_KEY_LIVE;
  const defaultKey = process.env.STRIPE_SECRET_KEY;
  const resolvedMode = mode || (process.env.STRIPE_MODE || '').toUpperCase();
  if (resolvedMode === 'LIVE') {
    if (!liveKey && !defaultKey) return null;
    if (!stripeLiveClient) {
      stripeLiveClient = new Stripe(liveKey || defaultKey as string, { apiVersion: '2023-10-16' });
    }
    return stripeLiveClient;
  }
  if (!testKey && !defaultKey) return null;
  if (!stripeTestClient) {
    stripeTestClient = new Stripe(testKey || defaultKey as string, { apiVersion: '2023-10-16' });
  }
  return stripeTestClient;
};

export const isStripeId = (value: string, prefix: string) => {
  if (!value) return false;
  return value.startsWith(prefix) && value.length > prefix.length + 6;
};
