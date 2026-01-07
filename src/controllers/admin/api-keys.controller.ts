import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { ApiKeyStatus } from '@prisma/client';

const DEFAULT_API_SCOPES = [
  { key: 'models.read', label: 'Models (read)' },
  { key: 'matches.read', label: 'Matches (read)' },
  { key: 'matches.write', label: 'Matches (write)' },
  { key: 'account.read', label: 'Account (read)' }
];

const getScopeLabel = (scope: string) => {
  const parts = scope.split('.');
  const area = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : scope;
  const action = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : '';
  return action ? `${area} (${action})` : area;
};

export const apiKeyScopesForAdmin = async () => {
  const ent = await prisma.subscriptionEntitlement.findUnique({ where: { key: 'api.scopes.allowed' } });
  if (!ent || !ent.default_value) return DEFAULT_API_SCOPES;
  if (Array.isArray(ent.default_value)) {
    return ent.default_value.map(scope => ({ key: String(scope), label: getScopeLabel(String(scope)) }));
  }
  return DEFAULT_API_SCOPES;
};

export const apiKeysDashboard = async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const scope = String(req.query.scope || '').trim();

  const where: any = {};
  if (status) where.status = status;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { prefix: { contains: q, mode: 'insensitive' } }
    ];
  }
  if (scope) {
    where.scopes = { some: { scope_key: scope } };
  }

  const [keys, scopes, usage] = await Promise.all([
    prisma.apiKey.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { user: { select: { email: true } }, scopes: true }
    }),
    apiKeyScopesForAdmin(),
    prisma.apiKeyUsage.groupBy({
      by: ['key_id'],
      _sum: { count: true }
    })
  ]);
  const usageMap = usage.reduce<Record<string, number>>((acc, row) => {
    acc[row.key_id] = row._sum.count || 0;
    return acc;
  }, {});

  res.render('admin/api-keys/index', {
    title: 'API Keys',
    path: '/admin/api-keys',
    keys,
    scopes,
    usageMap,
    query: req.query
  });
};

export const apiKeyUsageData = async (req: Request, res: Response) => {
  const keyId = String(req.query.keyId || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const where: any = {};
  if (keyId) where.key_id = keyId;
  if (from || to) {
    where.window_start = {};
    if (from) where.window_start.gte = new Date(from);
    if (to) where.window_start.lte = new Date(to);
  }
  const [rows, series] = await Promise.all([
    prisma.apiKeyUsage.findMany({
      where,
      orderBy: { window_start: 'desc' },
      take: 500
    }),
    prisma.apiKeyUsage.groupBy({
      by: ['window_start'],
      where,
      _sum: { count: true },
      orderBy: { window_start: 'asc' }
    })
  ]);
  res.json({
    rows,
    series: series.map(point => ({ window_start: point.window_start, count: point._sum.count || 0 }))
  });
};

export const updateApiKey = async (req: Request, res: Response) => {
  const { id } = req.params;
  const status = req.body.status as string;
  const scopes = Array.isArray(req.body.scopes) ? req.body.scopes : req.body.scopes ? [req.body.scopes] : [];

  const key = await prisma.apiKey.findUnique({ where: { id }, include: { scopes: true } });
  if (!key) return res.redirect('/admin/users?error=API key not found');

  const sanitizedStatus = (['ACTIVE', 'REVOKED', 'SUSPENDED'] as ApiKeyStatus[]).includes(status as ApiKeyStatus)
    ? (status as ApiKeyStatus)
    : key.status;
  const allowedScopes = (await apiKeyScopesForAdmin()).map(scope => scope.key);
  const filteredScopes = scopes.filter((scope: string) => allowedScopes.includes(scope));

  await prisma.$transaction(async tx => {
    await tx.apiKey.update({
      where: { id },
      data: { status: sanitizedStatus }
    });
    await tx.apiKeyScope.deleteMany({ where: { key_id: id } });
    if (filteredScopes.length > 0) {
      await tx.apiKeyScope.createMany({
        data: filteredScopes.map((scope: string) => ({ key_id: id, scope_key: scope }))
      });
    }
    await tx.apiKeyAuditLog.create({
      data: {
        actor_user_id: (req.session as any).userId,
        target_key_id: id,
        action: 'UPDATE',
        before: { status: key.status, scopes: key.scopes.map(s => s.scope_key) },
        after: { status: sanitizedStatus, scopes: filteredScopes }
      }
    });
  });

  res.redirect(`/admin/users/${key.user_id}?success=API key updated`);
};

export const revokeApiKey = async (req: Request, res: Response) => {
  const { id } = req.params;
  const key = await prisma.apiKey.findUnique({ where: { id }, include: { scopes: true } });
  if (!key) return res.redirect('/admin/users?error=API key not found');

  await prisma.$transaction(async tx => {
    await tx.apiKey.update({ where: { id }, data: { status: 'REVOKED' } });
    await tx.apiKeyAuditLog.create({
      data: {
        actor_user_id: (req.session as any).userId,
        target_key_id: id,
        action: 'REVOKE',
        before: { status: key.status, scopes: key.scopes.map(s => s.scope_key) },
        after: { status: 'REVOKED' }
      }
    });
  });

  res.redirect(`/admin/users/${key.user_id}?success=API key revoked`);
};
