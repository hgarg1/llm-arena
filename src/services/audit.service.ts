import { prisma } from '../config/db';

export const logAdminAction = async (adminId: string, action: string, target?: string, metadata?: any) => {
  try {
    await prisma.adminAuditLog.create({
      data: {
        admin_id: adminId,
        action,
        target,
        metadata
      }
    });
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
};
