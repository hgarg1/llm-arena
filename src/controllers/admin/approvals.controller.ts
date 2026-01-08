import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { logAdminAction } from '../../services/audit.service';

export const approvalsDashboard = async (req: Request, res: Response) => {
  const status = String(req.query.status || 'PENDING').toUpperCase();
  const q = String(req.query.q || '').trim();
  const permission = String(req.query.permission || '').trim();
  const requester = String(req.query.requester || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();

  const where: any = { status: status === 'ALL' ? undefined : status };
  if (q) {
    where.OR = [
      { permission_key: { contains: q, mode: 'insensitive' } },
      { requester: { email: { contains: q, mode: 'insensitive' } } }
    ];
  }
  if (permission) where.permission_key = permission;
  if (requester) where.requester_id = requester;
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to) where.created_at.lte = new Date(to);
  }

  const [requests, counts, permissionOptions, requesterOptions] = await Promise.all([
    prisma.adminAccessRequest.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        requester: { select: { id: true, email: true } },
        reviewer: { select: { id: true, email: true } }
      }
    }),
    prisma.adminAccessRequest.groupBy({
      by: ['status'],
      _count: { id: true }
    }),
    prisma.adminAccessRequest.findMany({
      distinct: ['permission_key'],
      select: { permission_key: true },
      orderBy: { permission_key: 'asc' }
    }),
    prisma.adminAccessRequest.findMany({
      distinct: ['requester_id'],
      select: { requester: { select: { id: true, email: true } } },
      orderBy: { requester_id: 'asc' }
    })
  ]);

  const stats = counts.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = row._count.id;
    return acc;
  }, {});

  res.render('admin/approvals/index', {
    title: 'Approvals',
    path: '/admin/approvals',
    requests,
    stats,
    permissions: permissionOptions.map(p => p.permission_key),
    requesters: requesterOptions.map(r => r.requester).filter(Boolean),
    status,
    query: req.query,
    success: req.query.success,
    error: req.query.error
  });
};

export const approveRequest = async (req: Request, res: Response) => {
  const { id } = req.params;
  const adminId = (req.session as any).userId;
  const request = await prisma.adminAccessRequest.findUnique({ where: { id } });
  if (!request) return res.redirect('/admin/approvals?error=Request not found');

  const permission = await prisma.rbacPermission.findUnique({ where: { key: request.permission_key } });
  if (!permission) return res.redirect('/admin/approvals?error=Permission not found');

  await prisma.$transaction(async tx => {
    await tx.rbacUserPermissionOverride.upsert({
      where: { user_id_permission_id: { user_id: request.requester_id, permission_id: permission.id } },
      update: { effect: 'ALLOW' },
      create: { user_id: request.requester_id, permission_id: permission.id, effect: 'ALLOW' }
    });
    await tx.adminAccessRequest.update({
      where: { id },
      data: { status: 'APPROVED', reviewed_by: adminId, reviewed_at: new Date() }
    });
  });

  await logAdminAction(adminId, 'access.request.approve', id, { permission: request.permission_key });
  res.redirect('/admin/approvals?success=Access granted');
};

export const denyRequest = async (req: Request, res: Response) => {
  const { id } = req.params;
  const adminId = (req.session as any).userId;
  const request = await prisma.adminAccessRequest.findUnique({ where: { id } });
  if (!request) return res.redirect('/admin/approvals?error=Request not found');

  await prisma.adminAccessRequest.update({
    where: { id },
    data: { status: 'DENIED', reviewed_by: adminId, reviewed_at: new Date() }
  });

  await logAdminAction(adminId, 'access.request.deny', id, { permission: request.permission_key });
  res.redirect('/admin/approvals?success=Request denied');
};

export const getUserBlocks = async (req: Request, res: Response) => {
  const blocks = await prisma.userBlock.findMany({
    include: {
      blocker: { select: { id: true, email: true, can_block_people: true } },
      blocked: { select: { id: true, email: true } }
    },
    orderBy: { created_at: 'desc' }
  });

  res.render('admin/approvals/blocks', {
    title: 'User Blocks',
    path: '/admin/approvals/blocks',
    blocks
  });
};

export const deleteUserBlock = async (req: Request, res: Response) => {
  const { id } = req.body;
  await prisma.userBlock.delete({ where: { id } });
  res.redirect('/admin/approvals/blocks?success=Block removed');
};

export const toggleUserBlockCapability = async (req: Request, res: Response) => {
  const { userId } = req.body;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user) {
    await prisma.user.update({
      where: { id: userId },
      data: { can_block_people: !user.can_block_people }
    });
  }
  res.redirect('/admin/approvals/blocks?success=Capability updated');
};

