import { prisma } from '../config/db';
import { getEnv } from '../config/runtime';

export type Acquire = { allowed: true } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /** Takes one request and `estimatedTokens` tokens from the provider's buckets, or says how long to wait. */
  acquire(provider: string, estimatedTokens: number): Promise<Acquire>;
}

const envName = (provider: string) => provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');

const positive = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** `PROVIDER_RPM_OPENAI` / `PROVIDER_TPM_OPENAI` (requests / tokens per minute). Unset means unlimited. */
export const limitsFor = (provider: string) => ({
  rpm: positive(getEnv(`PROVIDER_RPM_${envName(provider)}`)),
  tpm: positive(getEnv(`PROVIDER_TPM_${envName(provider)}`))
});

/** A bucket holds about five seconds of burst; the rest is the steady refill rate. */
const BURST_SECONDS = 5;

/**
 * Atomic token bucket in Postgres, shared by every runner process. One statement refills the bucket for the
 * time elapsed, takes `cost` if enough is available, and returns nothing otherwise (so concurrent callers can
 * never take more than the bucket holds).
 */
export const takeFromBucket = async (key: string, perMinute: number, cost: number): Promise<Acquire> => {
  const ratePerSec = perMinute / 60;
  const capacity = Math.max(perMinute * BURST_SECONDS / 60, 1);
  const take = Math.min(cost, capacity); // a request bigger than the bucket would otherwise never succeed
  const rows = await prisma.$queryRaw<Array<{ tokens: number }>>`
    INSERT INTO "ProviderRateLimit" ("key", tokens, updated_at)
    VALUES (${key}, ${capacity - take}::double precision, now())
    ON CONFLICT ("key") DO UPDATE SET
      tokens = LEAST(${capacity}::double precision, "ProviderRateLimit".tokens + EXTRACT(EPOCH FROM (now() - "ProviderRateLimit".updated_at)) * ${ratePerSec}::double precision) - ${take}::double precision,
      updated_at = now()
    WHERE LEAST(${capacity}::double precision, "ProviderRateLimit".tokens + EXTRACT(EPOCH FROM (now() - "ProviderRateLimit".updated_at)) * ${ratePerSec}::double precision) >= ${take}::double precision
    RETURNING tokens`;
  if (rows.length > 0) return { allowed: true };

  const current = await prisma.$queryRaw<Array<{ available: number }>>`
    SELECT LEAST(${capacity}::double precision, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * ${ratePerSec}::double precision) AS available
    FROM "ProviderRateLimit" WHERE "key" = ${key}`;
  const available = current[0]?.available ?? 0;
  return { allowed: false, retryAfterMs: Math.max(50, Math.ceil(((take - available) / ratePerSec) * 1000)) };
};

export const createDbRateLimiter = (): RateLimiter => ({
  async acquire(provider, estimatedTokens) {
    const { rpm, tpm } = limitsFor(provider);
    if (rpm) {
      const result = await takeFromBucket(`${provider}:rpm`, rpm, 1);
      if (!result.allowed) return result;
    }
    if (tpm) {
      const result = await takeFromBucket(`${provider}:tpm`, tpm, Math.max(1, estimatedTokens));
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }
});
