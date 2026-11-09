export const getEnv = (name: string) => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
};

const isTrue = (name: string) => {
  const value = getEnv(name).toLowerCase();
  return value === 'true' || value === '1';
};

export const isVercelRuntime = isTrue('VERCEL');

export const isRedisConfigured = () => Boolean(getEnv('REDIS_URL'));

export const isRedisSessionEnabled = () =>
  isTrue('REDIS_SESSION_ENABLED') && isRedisConfigured();

export const isRedisRuntimeEnabled = () =>
  isRedisConfigured() &&
  (
    isTrue('REDIS_RUNTIME_ENABLED') ||
    isTrue('REDIS_SESSION_ENABLED') ||
    isTrue('MATCH_QUEUE_ENABLED')
  );

export const isDatabaseConfigured = () => Boolean(getEnv('DATABASE_URL'));

export const isQueueEnabled = () =>
  isTrue('MATCH_QUEUE_ENABLED') && isRedisConfigured();

export type RunnerMode = 'vercel' | 'bullmq' | 'inline' | 'none';

/**
 * How matches get executed:
 *  - `vercel`: resumable slices run in their own Vercel function, chained and healed by a cron sweeper
 *  - `bullmq`: a BullMQ worker process (Docker/VM) consumes a Redis queue
 *  - `inline`: in this process (local development)
 * Unset keeps the previous behaviour: BullMQ when the queue is configured, otherwise nothing runs.
 */
export const getRunnerMode = (): RunnerMode => {
  const requested = getEnv('MATCH_RUNNER').toLowerCase();
  if (requested === 'vercel' || requested === 'inline') return requested;
  if ((requested === 'bullmq' || requested === '') && isQueueEnabled()) return 'bullmq';
  return 'none';
};

export const isRunnerEnabled = () => getRunnerMode() !== 'none';

export const isRealtimeEnabled = () =>
  isTrue('REALTIME_ENABLED') && !isVercelRuntime;

export const getSiteUrl = () =>
  getEnv('SITE_URL') || 'https://llm-arena.harshit-garg.com';

export const getCanonicalHost = () => {
  try {
    return new URL(getSiteUrl()).host;
  } catch {
    return 'llm-arena.harshit-garg.com';
  }
};
