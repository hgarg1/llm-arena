import { prisma } from '../config/db';
import { EntitlementOverrideTarget, EntitlementValueType } from '@prisma/client';
import { checkQuota, incrementUsage } from './usage-counter.service';

type ResolvedEntitlement = {
  enabled: boolean;
  value: any;
  source: 'plan' | 'org_override' | 'user_override' | 'default';
};

type ResolveInput = {
  userId?: string;
  orgId?: string | null;
  planId?: string | null;
  planTier?: 'FREE' | 'PRO' | 'ENTERPRISE';
};

const tierToLevel = (tier?: string | null) => {
  if (tier === 'ENTERPRISE') return 3;
  if (tier === 'PRO') return 2;
  return 1;
};

const pickPlanByTier = async (tier?: 'FREE' | 'PRO' | 'ENTERPRISE') => {
  if (!tier) return null;
  const level = tierToLevel(tier);
  return prisma.subscriptionPlan.findFirst({
    where: { is_active: true, level: { gte: level } },
    orderBy: { level: 'asc' }
  });
};

const isWithinWindow = (now: Date, startsAt?: Date | null, endsAt?: Date | null) => {
  if (startsAt && now < startsAt) return false;
  if (endsAt && now > endsAt) return false;
  return true;
};

const coerceValue = (type: EntitlementValueType, value: any) => {
  if (value === undefined) return undefined;
  if (type === 'BOOL') return Boolean(value);
  if (type === 'NUMBER') return typeof value === 'number' ? value : Number(value);
  if (type === 'STRING') return value === null ? null : String(value);
  if (type === 'ENUM') return value === null ? null : String(value);
  return value;
};

const validateValue = (schema: any, value: any) => {
  if (!schema) return true;
  const type = schema.type;
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    return true;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    return true;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (schema.items && schema.items.type === 'string') {
      return value.every((item: any) => typeof item === 'string');
    }
    return true;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) return false;
      }
    }
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (value[key] === undefined) continue;
        if (!validateValue(prop, value[key])) return false;
      }
    }
    return true;
  }
  return true;
};

export const resolveEntitlements = async (input: ResolveInput) => {
  const now = new Date();
  const [definitions, overrides] = await Promise.all([
    prisma.subscriptionEntitlement.findMany({
      include: { plans: true }
    }),
    prisma.entitlementOverride.findMany({
      where: {
        OR: [
          input.orgId ? { target_type: EntitlementOverrideTarget.ORG, target_id: input.orgId } : undefined,
          input.userId ? { target_type: EntitlementOverrideTarget.USER, target_id: input.userId } : undefined
        ].filter(Boolean) as any
      }
    })
  ]);

  let planId = input.planId || null;
  if (!planId && input.userId) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { plan_id: true, tier: true, org_id: true, organization: { select: { plan_id: true } } }
    });
    if (user?.organization?.plan_id) planId = user.organization.plan_id;
    if (!planId && user?.plan_id) planId = user.plan_id;
    if (!planId) {
      const plan = await pickPlanByTier(user?.tier || input.planTier);
      planId = plan?.id || null;
    }
  }
  if (!planId && input.planTier) {
    const plan = await pickPlanByTier(input.planTier);
    planId = plan?.id || null;
  }

  const resolved: Record<string, ResolvedEntitlement> = {};

  for (const def of definitions) {
    const planEnt = planId ? def.plans.find(p => p.plan_id === planId) : undefined;
    let enabled = planEnt ? planEnt.enabled : false;
    let value = planEnt?.value ?? def.default_value;
    let source: ResolvedEntitlement['source'] = planEnt ? 'plan' : 'default';

    if (def.value_type === 'BOOL' && planEnt && planEnt.value === null) {
      value = enabled;
    }

    const orgOverride = overrides.find(o =>
      o.entitlement_key === def.key &&
      o.target_type === EntitlementOverrideTarget.ORG &&
      isWithinWindow(now, o.starts_at, o.ends_at)
    );
    if (orgOverride) {
      enabled = orgOverride.enabled;
      if (def.value_type === 'BOOL' && orgOverride.value === null) {
        value = enabled;
      } else if (orgOverride.value !== null && orgOverride.value !== undefined) {
        value = orgOverride.value;
      }
      source = 'org_override';
    }

    const userOverride = overrides.find(o =>
      o.entitlement_key === def.key &&
      o.target_type === EntitlementOverrideTarget.USER &&
      isWithinWindow(now, o.starts_at, o.ends_at)
    );
    if (userOverride) {
      enabled = userOverride.enabled;
      if (def.value_type === 'BOOL' && userOverride.value === null) {
        value = enabled;
      } else if (userOverride.value !== null && userOverride.value !== undefined) {
        value = userOverride.value;
      }
      source = 'user_override';
    }

    const coerced = coerceValue(def.value_type, value);
    const valid = validateValue(def.validation_schema as any, coerced);
    resolved[def.key] = {
      enabled: enabled && valid,
      value: valid ? coerced : def.default_value,
      source
    };
  }

  const hasEntitlement = (key: string) => resolved[key]?.enabled === true;
  const entitlementValue = <T>(key: string, fallback?: T): T | undefined => {
    if (!resolved[key]) return fallback;
    return (resolved[key].value as T) ?? fallback;
  };

  const enforceMode = (key: string, requiredMode: 'hidden' | 'view' | 'edit' | 'admin' | 'locked') => {
    const mode = String(entitlementValue(key, 'hidden'));
    const rank = (value: string) => {
      if (value === 'admin') return 4;
      if (value === 'edit') return 3;
      if (value === 'view') return 2;
      if (value === 'hidden') return 1;
      return 0;
    };
    return rank(mode) >= rank(requiredMode);
  };

  const enforceQuota = async (key: string, scope: { type: 'user' | 'org'; id: string }) => {
    const config = entitlementValue<any>(key, null);
    if (!config || !config.limit) {
      return { allowed: true, remaining: null, resetAt: null, overage_behavior: null };
    }
    const result = await checkQuota({
      entitlementKey: key,
      scopeType: scope.type === 'org' ? 'ORG' : 'USER',
      scopeId: scope.id,
      limit: config.limit,
      window: config.window || 'day'
    });
    return { ...result, overage_behavior: config.overage_behavior || 'block' };
  };

  return {
    resolved,
    hasEntitlement,
    entitlementValue,
    enforceMode,
    enforceQuota,
    incrementUsage
  };
};


export const entitlementsService = {
  check: async (userId: string, entitlementKey: string) => {
    const { hasEntitlement } = await resolveEntitlements({ userId });
    return hasEntitlement(entitlementKey);
  }
};
