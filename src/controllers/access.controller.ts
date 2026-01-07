import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { logAdminAction } from '../services/audit.service';

export const requestAccess = async (req: Request, res: Response) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.redirect('/auth/login');
  const permission = String(req.body.permission || '').trim();
  const path = String(req.body.path || '').trim() || null;
  const method = String(req.body.method || '').trim() || null;
  const reason = String(req.body.reason || '').trim() || null;

  if (!permission) {
    return res.redirect('/access/requested?error=Missing permission');
  }

  const existing = await prisma.adminAccessRequest.findFirst({
    where: { requester_id: userId, permission_key: permission, status: 'PENDING' }
  });
  if (existing) {
    return res.redirect('/access/requested?success=Request already pending');
  }

  const request = await prisma.adminAccessRequest.create({
    data: {
      requester_id: userId,
      permission_key: permission,
      path,
      method,
      reason
    }
  });
  await logAdminAction(userId, 'access.request', request.id, { permission, path, method });
  return res.redirect('/access/requested?success=Request submitted');
};

export const requestConfirmation = async (req: Request, res: Response) => {
  res.render('access/requested', {
    title: 'Access Request',
    path: '/access/requested',
    success: req.query.success,
    error: req.query.error
  });
};
