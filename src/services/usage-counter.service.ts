import { prisma } from '../config/db';

type Window = 'minute' | 'hour' | 'day' | 'month';
type ScopeType = 'USER' | 'ORG' | 'API_KEY' | 'MODEL';

const getWindowStart = (window: Window, now = new Date()) => {
  const date = new Date(now);
  if (window === 'minute') {
    date.setSeconds(0, 0);
  } else if (window === 'hour') {
    date.setMinutes(0, 0, 0);
  } else if (window === 'day') {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
  }
  return date;
};

export const incrementUsage = async (input: {
  entitlementKey: string;
  scopeType: ScopeType;
  scopeId: string;
  window: Window;
  amount?: number;
}) => {
  const amount = input.amount ?? 1;
  const windowStart = getWindowStart(input.window);
  await prisma.usageCounter.upsert({
    where: {
      scope_type_scope_id_entitlement_key_window_start: {
        scope_type: input.scopeType as any,
        scope_id: input.scopeId,
        entitlement_key: input.entitlementKey,
        window_start: windowStart
      }
    },
    update: { count: { increment: amount } },
    create: {
      scope_type: input.scopeType as any,
      scope_id: input.scopeId,
      entitlement_key: input.entitlementKey,
      window_start: windowStart,
      count: amount
    }
  });
};

export const checkQuota = async (input: {
  entitlementKey: string;
  scopeType: ScopeType;
  scopeId: string;
  limit: number;
  window: Window;
}) => {
  const windowStart = getWindowStart(input.window);
  const row = await prisma.usageCounter.findUnique({
    where: {
      scope_type_scope_id_entitlement_key_window_start: {
        scope_type: input.scopeType as any,
        scope_id: input.scopeId,
        entitlement_key: input.entitlementKey,
        window_start: windowStart
      }
    }
  });
  const count = row?.count || 0;
  const remaining = Math.max(0, input.limit - count);
  const allowed = count < input.limit;
  let resetAt: Date | null = null;
  if (input.window === 'minute') {
    resetAt = new Date(windowStart.getTime() + 60 * 1000);
  } else if (input.window === 'hour') {
    resetAt = new Date(windowStart.getTime() + 60 * 60 * 1000);
  } else if (input.window === 'day') {
    resetAt = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
  } else {
    const nextMonth = new Date(windowStart);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    resetAt = nextMonth;
  }

  return { allowed, remaining, resetAt };
};


/**
 * Atomically takes one unit of quota. A single upsert increments the counter only while it is below
 * the limit, so concurrent requests can never overshoot it (unlike check-then-increment).
 */
export const reserveUsage = async (input: {
  entitlementKey: string;
  scopeType: ScopeType;
  scopeId: string;
  limit: number;
  window: Window;
}): Promise<boolean> => {
  const windowStart = getWindowStart(input.window);
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "UsageCounter" (id, scope_type, scope_id, entitlement_key, window_start, count, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${input.scopeType}::"UsageScopeType", ${input.scopeId}, ${input.entitlementKey}, ${windowStart}, 1, now(), now())
    ON CONFLICT (scope_type, scope_id, entitlement_key, window_start)
    DO UPDATE SET count = "UsageCounter".count + 1, updated_at = now()
    WHERE "UsageCounter".count < ${input.limit}
    RETURNING count`;
  return rows.length > 0;
};

/** Gives back a unit taken by `reserveUsage` (e.g. the guarded action failed). */
export const releaseUsage = async (input: {
  entitlementKey: string;
  scopeType: ScopeType;
  scopeId: string;
  window: Window;
}) => {
  const windowStart = getWindowStart(input.window);
  await prisma.$executeRaw`
    UPDATE "UsageCounter" SET count = GREATEST(count - 1, 0), updated_at = now()
    WHERE scope_type = ${input.scopeType}::"UsageScopeType" AND scope_id = ${input.scopeId}
      AND entitlement_key = ${input.entitlementKey} AND window_start = ${windowStart}`;
};
