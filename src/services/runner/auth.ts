import { createHmac, timingSafeEqual } from 'crypto';
import { getEnv } from '../../config/runtime';

const MAX_SKEW_MS = 5 * 60 * 1000;

const sign = (secret: string, timestamp: string, subject: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${subject}`).digest('hex');

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Headers that authorise one internal call about `subject` (a match id, or "sweep"). */
export const signRunnerRequest = (subject: string, now = Date.now()): Record<string, string> => {
  const secret = getEnv('MATCH_RUNNER_SECRET');
  if (!secret) throw new Error('MATCH_RUNNER_SECRET is not configured');
  const timestamp = String(now);
  return { 'x-runner-timestamp': timestamp, 'x-runner-signature': sign(secret, timestamp, subject) };
};

type HeaderBag = Record<string, string | string[] | undefined>;
const header = (headers: HeaderBag, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Verifies a signed internal call. Fails closed when no secret is configured. */
export const verifyRunnerRequest = (headers: HeaderBag, subject: string, now = Date.now()): boolean => {
  const secret = getEnv('MATCH_RUNNER_SECRET');
  const timestamp = header(headers, 'x-runner-timestamp');
  const signature = header(headers, 'x-runner-signature');
  if (!secret || !timestamp || !signature) return false;
  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SKEW_MS) return false;
  return equal(signature, sign(secret, timestamp, subject));
};

/** Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET`. */
export const verifyCronRequest = (headers: HeaderBag): boolean => {
  const secret = getEnv('CRON_SECRET');
  const authorization = header(headers, 'authorization');
  return Boolean(secret && authorization && equal(authorization, `Bearer ${secret}`));
};
