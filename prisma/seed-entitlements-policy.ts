import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_ENTITLEMENTS = [
  {
    key: 'matches.quota',
    description: 'Match creation quota policy',
    value_type: 'JSON' as const,
    default_value: { limit: 10, window: 'day', scope: 'user', burst: 0, overage_behavior: 'block' },
    validation_schema: {
      type: 'object',
      required: ['limit', 'window', 'scope', 'overage_behavior'],
      properties: {
        limit: { type: 'number', minimum: 0 },
        window: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
        scope: { type: 'string', enum: ['user', 'org'] },
        burst: { type: 'number', minimum: 0 },
        overage_behavior: { type: 'string', enum: ['block', 'queue', 'degrade', 'bill_overage'] }
      }
    }
  },
  {
    key: 'matches.concurrent',
    description: 'Max concurrent matches',
    value_type: 'NUMBER' as const,
    default_value: 1,
    validation_schema: { type: 'number', minimum: 0 }
  },
  {
    key: 'queue.priority',
    description: 'Queue priority tier',
    value_type: 'ENUM' as const,
    default_value: 'standard',
    validation_schema: { type: 'string', enum: ['low', 'standard', 'high', 'critical'] }
  },
  {
    key: 'engine.generate',
    description: 'Engine generation policy',
    value_type: 'JSON' as const,
    default_value: { enabled: true, quota: { limit: 5, window: 'day', scope: 'user', overage_behavior: 'block' } },
    validation_schema: { type: 'object' }
  },
  {
    key: 'engine.publish',
    description: 'Engine publish access mode',
    value_type: 'ENUM' as const,
    default_value: 'admin',
    validation_schema: { type: 'string', enum: ['hidden', 'view', 'edit', 'admin', 'locked'] }
  },
  {
    key: 'models.allowed_providers',
    description: 'Allowed model providers',
    value_type: 'JSON' as const,
    default_value: [],
    validation_schema: { type: 'array', items: { type: 'string' } }
  },
  {
    key: 'models.allowed_ids',
    description: 'Allowed model IDs',
    value_type: 'JSON' as const,
    default_value: [],
    validation_schema: { type: 'array', items: { type: 'string' } }
  },
  {
    key: 'retention.days',
    description: 'Data retention days',
    value_type: 'NUMBER' as const,
    default_value: 30,
    validation_schema: { type: 'number', minimum: 1, maximum: 3650 }
  },
  {
    key: 'export.csv',
    description: 'Allow data exports',
    value_type: 'BOOL' as const,
    default_value: false,
    validation_schema: { type: 'boolean' }
  },
  {
    key: 'security.require_sso',
    description: 'Require SSO',
    value_type: 'BOOL' as const,
    default_value: false,
    validation_schema: { type: 'boolean' }
  },
  {
    key: 'security.require_mfa',
    description: 'Require MFA',
    value_type: 'BOOL' as const,
    default_value: false,
    validation_schema: { type: 'boolean' }
  },
  {
    key: 'api.key.create',
    description: 'Allow API key creation',
    value_type: 'BOOL' as const,
    default_value: true,
    validation_schema: { type: 'boolean' }
  },
  {
    key: 'api.key.max',
    description: 'Max API keys per user',
    value_type: 'NUMBER' as const,
    default_value: 3,
    validation_schema: { type: 'number', minimum: 0 }
  },
  {
    key: 'api.scopes.allowed',
    description: 'Allowed API scopes',
    value_type: 'JSON' as const,
    default_value: ['models.read', 'matches.read', 'matches.write', 'account.read'],
    validation_schema: { type: 'array', items: { type: 'string' } }
  },
  {
    key: 'api.requests.quota',
    description: 'API request quota policy',
    value_type: 'JSON' as const,
    default_value: { limit: 1000, window: 'day', scope: 'api_key', overage_behavior: 'block' },
    validation_schema: {
      type: 'object',
      required: ['limit', 'window', 'scope', 'overage_behavior'],
      properties: {
        limit: { type: 'number', minimum: 0 },
        window: { type: 'string', enum: ['minute', 'hour', 'day', 'month'] },
        scope: { type: 'string', enum: ['api_key'] },
        overage_behavior: { type: 'string', enum: ['block', 'queue', 'degrade', 'bill_overage'] }
      }
    }
  }
];

const tierFromLevel = (level: number) => {
  if (level >= 3) return 'ENTERPRISE' as const;
  if (level >= 2) return 'PRO' as const;
  return 'FREE' as const;
};

async function main() {
  for (const entitlement of DEFAULT_ENTITLEMENTS) {
    await prisma.subscriptionEntitlement.upsert({
      where: { key: entitlement.key },
      update: {
        description: entitlement.description,
        value_type: entitlement.value_type,
        default_value: entitlement.default_value as any,
        validation_schema: entitlement.validation_schema as any
      },
      create: {
        key: entitlement.key,
        description: entitlement.description,
        value_type: entitlement.value_type,
        default_value: entitlement.default_value as any,
        validation_schema: entitlement.validation_schema as any
      }
    });
  }

  const entitlements = await prisma.subscriptionEntitlement.findMany({});
  for (const ent of entitlements) {
    if (!ent.value_type) {
      await prisma.subscriptionEntitlement.update({
        where: { id: ent.id },
        data: { value_type: 'BOOL', default_value: false }
      });
    }
  }

  const tiers = await prisma.subscriptionTierEntitlement.findMany({ include: { entitlement: true } });
  const plans = await prisma.subscriptionPlan.findMany({});
  for (const plan of plans) {
    const planTier = tierFromLevel(plan.level);
    for (const ent of entitlements) {
      const tierEntry = tiers.find(t => t.entitlement_id === ent.id && t.tier === planTier);
      const enabled = tierEntry ? tierEntry.enabled : false;
      const value = ent.value_type === 'BOOL'
        ? enabled
        : (enabled ? ent.default_value : null);
      await prisma.subscriptionPlanEntitlement.upsert({
        where: { plan_id_entitlement_id: { plan_id: plan.id, entitlement_id: ent.id } },
        update: { enabled, value: value as any },
        create: { plan_id: plan.id, entitlement_id: ent.id, enabled, value: value as any }
      });
    }
  }

  console.log('Entitlements seeded and plan defaults backfilled.');
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
