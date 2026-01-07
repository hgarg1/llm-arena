import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { addDataRows, applyColumnSizing, createStyledSheet, createWorkbook } from '../../services/excel-export.service';

const buildFilters = (req: Request) => {
  const q = String(req.query.q || '').trim();
  const action = String(req.query.action || '').trim();
  const adminId = String(req.query.admin || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();

  const where: any = {};
  if (action) where.action = action;
  if (adminId) where.admin_id = adminId;
  if (q) {
    where.OR = [
      { action: { contains: q, mode: 'insensitive' } },
      { target: { contains: q, mode: 'insensitive' } },
      { admin: { email: { contains: q, mode: 'insensitive' } } }
    ];
  }
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to) where.created_at.lte = new Date(to);
  }
  return { where, q, action, adminId, from, to };
};

export const auditDashboard = async (req: Request, res: Response) => {
  const { where } = buildFilters(req);

  const [logs, admins, actions, deniedCount, totalCount] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 200,
      include: { admin: { select: { id: true, email: true } } }
    }),
    prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { email: 'asc' },
      select: { id: true, email: true }
    }),
    prisma.adminAuditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' }
    }),
    prisma.adminAuditLog.count({ where: { action: 'access.denied' } }),
    prisma.adminAuditLog.count()
  ]);

  res.render('admin/audit/index', {
    title: 'Audit Log',
    path: '/admin/audit',
    logs,
    admins,
    actions: actions.map(a => a.action),
    stats: { deniedCount, totalCount },
    query: req.query,
    success: req.query.success,
    error: req.query.error
  });
};

export const exportAuditLogs = async (req: Request, res: Response) => {
  const entitlements = (req as any).entitlements;
  const canExport = !entitlements?.resolved?.['export.csv'] || entitlements.hasEntitlement('export.csv');
  if (!canExport) {
    return res.status(403).send('Export not allowed for your subscription.');
  }
  const { where } = buildFilters(req);
  const logs = await prisma.adminAuditLog.findMany({
    where,
    orderBy: { created_at: 'desc' },
    include: { admin: { select: { email: true } } }
  });

  const workbook = createWorkbook('Admin Audit Log');
  const columns = [
    { header: 'Timestamp', key: 'timestamp', width: 24 },
    { header: 'Admin', key: 'admin', width: 28 },
    { header: 'Action', key: 'action', width: 24 },
    { header: 'Target', key: 'target', width: 26 },
    { header: 'Metadata', key: 'metadata', width: 60 }
  ];
  const sheet = createStyledSheet(workbook, 'Audit Log', 'Admin Audit Log', columns);
  addDataRows(sheet, logs.map(l => ({
    timestamp: l.created_at.toISOString(),
    admin: l.admin?.email || '',
    action: l.action,
    target: l.target || '',
    metadata: JSON.stringify(l.metadata || {})
  })));
  applyColumnSizing(sheet, columns);

  const summaryColumns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 18 }
  ];
  const summary = createStyledSheet(workbook, 'Summary', 'Audit Summary', summaryColumns);
  const deniedCount = logs.filter(l => l.action === 'access.denied').length;
  const actions = logs.reduce<Record<string, number>>((acc, log) => {
    acc[log.action] = (acc[log.action] || 0) + 1;
    return acc;
  }, {});
  addDataRows(summary, [
    { metric: 'Total events', value: logs.length },
    { metric: 'Denied attempts', value: deniedCount },
    ...Object.entries(actions).map(([action, count]) => ({ metric: action, value: count }))
  ]);
  applyColumnSizing(summary, summaryColumns);

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=\"admin_audit_log.xlsx\"');
  res.send(Buffer.from(buffer as ArrayBuffer));
};
