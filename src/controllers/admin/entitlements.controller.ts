import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { logAdminAction } from '../../services/audit.service';
import { EntitlementValueType, Prisma } from '@prisma/client';

const tiers = ['FREE', 'PRO', 'ENTERPRISE'] as const;

const toJsonInput = (value: any) => (value === null ? Prisma.DbNull : value);

const ensureDefaultPlans = async () => {
  const defaults = [
    { key: 'free', name: 'Free', level: 1, description_short: 'Core access for evaluation basics.', description_long: 'Access to standard evaluations and public models.' },
    { key: 'pro', name: 'Pro', level: 2, description_short: 'Higher throughput for teams.', description_long: 'Expanded limits, faster queues, and advanced configuration.' },
    { key: 'enterprise', name: 'Enterprise', level: 3, description_short: 'Enterprise-grade controls.', description_long: 'Full control, compliance features, and dedicated support.' }
  ];

  for (const plan of defaults) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { key: plan.key } });
    if (!existing) {
      await prisma.subscriptionPlan.create({
        data: {
          key: plan.key,
          name: plan.name,
          level: plan.level,
          description_short: plan.description_short,
          description_long: plan.description_long,
          price_cents: plan.key === 'pro' ? 4900 : null
        }
      });
    }
  }
};

const ensureDefaultCategory = async () => {
  const existing = await prisma.subscriptionEntitlementCategory.findUnique({ where: { key: 'general' } });
  if (!existing) {
    await prisma.subscriptionEntitlementCategory.create({
      data: { key: 'general', name: 'General', description: 'Default entitlements' }
    });
  }
};

export const entitlementsDashboard = async (req: Request, res: Response) => {
  await ensureDefaultPlans();
  await ensureDefaultCategory();
  const plans = await prisma.subscriptionPlan.findMany({
    where: { is_active: true },
    orderBy: { level: 'asc' }
  });
  const categories = await prisma.subscriptionEntitlementCategory.findMany({
    orderBy: { name: 'asc' }
  });
  const entitlements = await prisma.subscriptionEntitlement.findMany({
    orderBy: { key: 'asc' },
    include: {
      tiers: true,
      plans: true,
      category: true,
      dependencies: { include: { depends_on: true } }
    }
  });
  const entitlementKeys = entitlements.map(ent => ent.key);
  const [overrides, auditLogs] = await Promise.all([
    prisma.entitlementOverride.findMany({
      where: { entitlement_key: { in: entitlementKeys } },
      include: { creator: { select: { id: true, email: true } } },
      orderBy: { created_at: 'desc' }
    }),
    prisma.entitlementAuditLog.findMany({
      where: { entitlement_key: { in: entitlementKeys } },
      include: { actor: { select: { id: true, email: true } } },
      orderBy: { created_at: 'desc' }
    })
  ]);

  for (const ent of entitlements) {
    for (const plan of plans) {
      const exists = ent.plans.find(p => p.plan_id === plan.id);
      if (!exists) {
        await prisma.subscriptionPlanEntitlement.create({
          data: { plan_id: plan.id, entitlement_id: ent.id, enabled: false }
        });
      }
    }
  }

  const stats = plans.reduce<Record<string, { enabled: number; total: number }>>((acc, plan) => {
    acc[plan.id] = { enabled: 0, total: entitlements.length };
    return acc;
  }, {});
  entitlements.forEach(ent => {
    plans.forEach(plan => {
      const existing = ent.plans.find(p => p.plan_id === plan.id);
      if (existing && existing.enabled) stats[plan.id].enabled += 1;
    });
  });

  res.render('admin/entitlements/index', {
    title: 'Entitlements',
    path: '/admin/entitlements',
    entitlements,
    tiers,
    plans,
    categories,
    overrides,
    auditLogs,
    stats,
    success: req.query.success,
    error: req.query.error
  });
};

export const createEntitlement = async (req: Request, res: Response) => {
  const key = (req.body.key || '').trim();
  const description = (req.body.description || '').trim();
  const valueType = (req.body.value_type || 'BOOL').toUpperCase();
  const defaultRaw = (req.body.default_value || '').trim();
  const validationRaw = (req.body.validation_schema || '').trim();
  if (!key) return res.redirect('/admin/entitlements?error=Key required');
  if (description.length < 10) return res.redirect('/admin/entitlements?error=Description must be at least 10 characters');
  if (!['BOOL', 'NUMBER', 'STRING', 'ENUM', 'JSON'].includes(valueType)) {
    return res.redirect('/admin/entitlements?error=Invalid value type');
  }
  try {
    const defaultCategory = await prisma.subscriptionEntitlementCategory.findUnique({ where: { key: 'general' } });
    let defaultValue: any = null;
    if (defaultRaw) {
      if (valueType === 'JSON') {
        defaultValue = JSON.parse(defaultRaw);
      } else if (valueType === 'NUMBER') {
        defaultValue = Number(defaultRaw);
      } else if (valueType === 'BOOL') {
        defaultValue = defaultRaw === 'true';
      } else {
        defaultValue = defaultRaw;
      }
    }
    let validationSchema: any = null;
    if (validationRaw) {
      validationSchema = JSON.parse(validationRaw);
    }
    const entitlement = await prisma.subscriptionEntitlement.create({
      data: { key, description, category_id: defaultCategory?.id, value_type: valueType as EntitlementValueType, default_value: defaultValue, validation_schema: validationSchema }
    });
    await logAdminAction((req.session as any).userId, 'entitlement.create', entitlement.id, { key });
    res.redirect('/admin/entitlements?success=Created');
  } catch (err) {
    res.redirect('/admin/entitlements?error=Failed to create entitlement');
  }
};

export const updateEntitlements = async (req: Request, res: Response) => {
  const [entitlements, plans] = await Promise.all([
    prisma.subscriptionEntitlement.findMany({ include: { tiers: true, plans: true } }),
    prisma.subscriptionPlan.findMany({ where: { is_active: true } })
  ]);

  await prisma.$transaction(async tx => {
    for (const entitlement of entitlements) {
      for (const plan of plans) {
        const field = `ent_${entitlement.id}_${plan.id}`;
        const enabled = req.body[field] === 'on';
        const existing = entitlement.plans.find(p => p.plan_id === plan.id);
        if (existing) {
          await tx.subscriptionPlanEntitlement.update({
            where: { id: existing.id },
            data: { enabled }
          });
        } else {
          await tx.subscriptionPlanEntitlement.create({
            data: {
              entitlement_id: entitlement.id,
              plan_id: plan.id,
              enabled
            }
          });
        }
      }
    }
  });

  await logAdminAction((req.session as any).userId, 'entitlement.update', 'tiers');
  res.redirect('/admin/entitlements?success=Saved');
};

export const updateEntitlementDetails = async (req: Request, res: Response) => {
  const { id } = req.params;
  const key = (req.body.key || '').trim();
  const description = (req.body.description || '').trim();
  const categoryId = (req.body.category_id || '').trim() || null;
  const usageLimit = req.body.usage_limit ? parseInt(req.body.usage_limit, 10) : null;
  const usageUnit = (req.body.usage_unit || '').trim() || null;
  const usagePeriod = (req.body.usage_period || '').trim() || null;
  const dependsOn = Array.isArray(req.body.depends_on) ? req.body.depends_on : req.body.depends_on ? [req.body.depends_on] : [];
  const valueType = (req.body.value_type || '').toUpperCase();
  const defaultRaw = (req.body.default_value || '').trim();
  const validationRaw = (req.body.validation_schema || '').trim();

  if (!key) return res.redirect('/admin/entitlements?error=Key required');
  if (description.length < 10) return res.redirect('/admin/entitlements?error=Description must be at least 10 characters');
  try {
    let defaultValue: any = undefined;
    let validationSchema: any = undefined;
    if (defaultRaw) {
      if (valueType === 'JSON') defaultValue = JSON.parse(defaultRaw);
      else if (valueType === 'NUMBER') defaultValue = Number(defaultRaw);
      else if (valueType === 'BOOL') defaultValue = defaultRaw === 'true';
      else defaultValue = defaultRaw;
    }
    if (validationRaw) validationSchema = JSON.parse(validationRaw);
    await prisma.$transaction(async tx => {
      await tx.subscriptionEntitlement.update({
        where: { id },
        data: {
          key,
          description,
          category_id: categoryId,
          usage_limit: usageLimit,
          usage_unit: usageUnit,
          usage_period: usagePeriod,
          value_type: valueType ? (valueType as EntitlementValueType) : undefined,
          default_value: defaultValue,
          validation_schema: validationSchema
        }
      });
      await tx.subscriptionEntitlementDependency.deleteMany({ where: { entitlement_id: id } });
      for (const depId of dependsOn) {
        if (depId === id) continue;
        await tx.subscriptionEntitlementDependency.create({
          data: { entitlement_id: id, depends_on_id: depId }
        });
      }
    });
    await logAdminAction((req.session as any).userId, 'entitlement.update', id, { key });
    res.redirect('/admin/entitlements?success=Updated');
  } catch (err) {
    res.redirect('/admin/entitlements?error=Failed to update entitlement');
  }
};

export const updateEntitlementPolicy = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlement = await prisma.subscriptionEntitlement.findUnique({
    where: { id },
    include: { plans: true }
  });
  if (!entitlement) return res.redirect('/admin/entitlements?error=Entitlement not found');

  const key = (req.body.key || entitlement.key).trim();
  const description = (req.body.description || entitlement.description || '').trim();
  const categoryId = (req.body.category_id || '').trim() || null;
  const usageLimit = req.body.usage_limit ? parseInt(req.body.usage_limit, 10) : null;
  const usageUnit = (req.body.usage_unit || '').trim() || null;
  const usagePeriod = (req.body.usage_period || '').trim() || null;
  const dependsOn = Array.isArray(req.body.depends_on) ? req.body.depends_on : req.body.depends_on ? [req.body.depends_on] : [];
  const valueType = (req.body.value_type || entitlement.value_type).toString().toUpperCase();
  const defaultRaw = (req.body.default_value || '').trim();
  const validationRaw = (req.body.validation_schema || '').trim();
  const enumOptions = (req.body.enum_options || '').trim();

  if (!key) return res.redirect('/admin/entitlements?error=Key required');
  if (description.length < 10) return res.redirect('/admin/entitlements?error=Description must be at least 10 characters');
  if (!['BOOL', 'NUMBER', 'STRING', 'ENUM', 'JSON'].includes(valueType)) {
    return res.redirect('/admin/entitlements?error=Invalid value type');
  }

  let defaultValue: any = entitlement.default_value;
  try {
    if (defaultRaw) {
      if (valueType === 'JSON') defaultValue = JSON.parse(defaultRaw);
      else if (valueType === 'NUMBER') defaultValue = Number(defaultRaw);
      else if (valueType === 'BOOL') defaultValue = defaultRaw === 'true';
      else defaultValue = defaultRaw;
    }
  } catch (err) {
    return res.redirect('/admin/entitlements?error=Default value must be valid JSON');
  }

  let validationSchema: any = entitlement.validation_schema;
  try {
    if (validationRaw) {
      validationSchema = JSON.parse(validationRaw);
    } else if (valueType === 'ENUM' && enumOptions) {
      validationSchema = { type: 'string', enum: enumOptions.split(',').map((opt: string) => opt.trim()).filter(Boolean) };
    } else if (valueType === 'BOOL') {
      validationSchema = { type: 'boolean' };
    } else if (valueType === 'NUMBER') {
      validationSchema = { type: 'number' };
    } else if (valueType === 'STRING') {
      validationSchema = { type: 'string' };
    }
  } catch (err) {
    return res.redirect('/admin/entitlements?error=Validation schema must be valid JSON');
  }

  const plans = await prisma.subscriptionPlan.findMany({ where: { is_active: true } });
  const planUpdates: Array<{ planId: string; enabled: boolean; value: any }> = [];

  for (const plan of plans) {
    const enabled = req.body[`plan_enabled_${plan.id}`] === 'on';
    const rawValue = (req.body[`plan_value_${plan.id}`] || '').trim();
    let value: any = null;
    try {
      if (valueType === 'JSON') {
        value = rawValue ? JSON.parse(rawValue) : null;
      } else if (valueType === 'NUMBER') {
        value = rawValue ? Number(rawValue) : null;
      } else if (valueType === 'BOOL') {
        value = enabled;
      } else {
        value = rawValue || null;
      }
    } catch (err) {
      return res.redirect('/admin/entitlements?error=Plan value must be valid JSON');
    }
    planUpdates.push({ planId: plan.id, enabled, value });
  }

  await prisma.$transaction(async tx => {
    const before = await tx.subscriptionEntitlement.findUnique({ where: { id } });
    await tx.subscriptionEntitlement.update({
      where: { id },
      data: {
        key,
        description,
        category_id: categoryId,
        usage_limit: usageLimit,
        usage_unit: usageUnit,
        usage_period: usagePeriod,
        value_type: valueType as EntitlementValueType,
        default_value: defaultValue,
        validation_schema: validationSchema
      }
    });
    await tx.subscriptionEntitlementDependency.deleteMany({ where: { entitlement_id: id } });
    for (const depId of dependsOn) {
      if (depId === id) continue;
      await tx.subscriptionEntitlementDependency.create({
        data: { entitlement_id: id, depends_on_id: depId }
      });
    }
    await tx.entitlementAuditLog.create({
      data: {
        actor_user_id: (req.session as any).userId,
        target_type: 'PLAN',
        target_id: 'definition',
        entitlement_key: key,
        action: 'UPDATE',
        before_value: before?.default_value ?? null,
        after_value: defaultValue ?? null,
        before_enabled: null,
        after_enabled: null
      }
    });

    for (const update of planUpdates) {
      const existing = await tx.subscriptionPlanEntitlement.findUnique({
        where: { plan_id_entitlement_id: { plan_id: update.planId, entitlement_id: entitlement.id } }
      });
      if (existing) {
        await tx.subscriptionPlanEntitlement.update({
          where: { id: existing.id },
          data: { enabled: update.enabled, value: update.value }
        });
      } else {
        await tx.subscriptionPlanEntitlement.create({
          data: { plan_id: update.planId, entitlement_id: entitlement.id, enabled: update.enabled, value: update.value }
        });
      }
      await tx.entitlementAuditLog.create({
        data: {
          actor_user_id: (req.session as any).userId,
          target_type: 'PLAN',
          target_id: update.planId,
          entitlement_key: key,
          action: 'UPDATE',
          before_value: existing?.value ?? null,
          after_value: update.value ?? null,
          before_enabled: existing?.enabled ?? null,
          after_enabled: update.enabled
        }
      });
    }
  });

  res.redirect(`/admin/entitlements?success=Policy updated`);
};

export const createEntitlementOverride = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlement = await prisma.subscriptionEntitlement.findUnique({ where: { id } });
  if (!entitlement) return res.redirect('/admin/entitlements?error=Entitlement not found');

  const targetType = (req.body.target_type || '').toUpperCase();
  const targetId = (req.body.target_id || '').trim();
  const enabled = req.body.enabled === 'on';
  const valueRaw = (req.body.value || '').trim();
  const startsAt = req.body.starts_at ? new Date(req.body.starts_at) : null;
  const endsAt = req.body.ends_at ? new Date(req.body.ends_at) : null;

  if (!['ORG', 'USER'].includes(targetType)) return res.redirect('/admin/entitlements?error=Invalid target type');
  if (!targetId) return res.redirect('/admin/entitlements?error=Target ID required');

  let value: any = null;
  try {
    value = valueRaw ? JSON.parse(valueRaw) : null;
  } catch (err) {
    return res.redirect('/admin/entitlements?error=Override value must be valid JSON');
  }

  const override = await prisma.entitlementOverride.create({
    data: {
      target_type: targetType as any,
      target_id: targetId,
      entitlement_key: entitlement.key,
      enabled,
      value,
      starts_at: startsAt,
      ends_at: endsAt,
      created_by: (req.session as any).userId
    }
  });

  await prisma.entitlementAuditLog.create({
    data: {
      actor_user_id: (req.session as any).userId,
      target_type: targetType as any,
      target_id: targetId,
      entitlement_key: entitlement.key,
      action: 'CREATE',
      before_value: null,
      after_value: value,
      before_enabled: null,
      after_enabled: enabled
    }
  });

  await logAdminAction((req.session as any).userId, 'entitlement.override.create', override.id, { key: entitlement.key });
  res.redirect('/admin/entitlements?success=Override created');
};

export const deleteEntitlementOverride = async (req: Request, res: Response) => {
  const { id } = req.params;
  const override = await prisma.entitlementOverride.findUnique({ where: { id } });
  if (!override) return res.redirect('/admin/entitlements?error=Override not found');

  await prisma.entitlementOverride.delete({ where: { id } });
  await prisma.entitlementAuditLog.create({
    data: {
      actor_user_id: (req.session as any).userId,
      target_type: override.target_type,
      target_id: override.target_id,
      entitlement_key: override.entitlement_key,
      action: 'DELETE',
      before_value: override.value,
      after_value: null,
      before_enabled: override.enabled,
      after_enabled: null
    }
  });
  await logAdminAction((req.session as any).userId, 'entitlement.override.delete', id, { key: override.entitlement_key });
  res.redirect('/admin/entitlements?success=Override deleted');
};

export const createEntitlementCategory = async (req: Request, res: Response) => {
  const key = (req.body.key || '').trim();
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim() || null;
  if (!key || !name) return res.redirect('/admin/entitlements?error=Key and name required');
  try {
    await prisma.subscriptionEntitlementCategory.create({
      data: { key, name, description }
    });
    await logAdminAction((req.session as any).userId, 'entitlement.category.create', key);
    res.redirect('/admin/entitlements?success=Category created');
  } catch (err) {
    res.redirect('/admin/entitlements?error=Failed to create category');
  }
};

export const deleteEntitlement = async (req: Request, res: Response) => {
  const { id } = req.params;
  const entitlement = await prisma.subscriptionEntitlement.findUnique({ where: { id } });
  if (!entitlement) return res.redirect('/admin/entitlements?error=Entitlement not found');

  await prisma.subscriptionEntitlement.delete({ where: { id } });
  await logAdminAction((req.session as any).userId, 'entitlement.delete', id, { key: entitlement.key });
  res.redirect('/admin/entitlements?success=Deleted');
};
