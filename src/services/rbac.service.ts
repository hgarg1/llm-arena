import { prisma } from '../config/db';

export const RBAC_PERMISSIONS = [
  { key: 'admin.access', description: 'Access admin portal' },
  { key: 'admin.dashboard.view', description: 'View admin dashboard' },
  { key: 'admin.users.view', description: 'View users' },
  { key: 'admin.users.edit', description: 'Edit users' },
  { key: 'admin.users.password_reset', description: 'Reset user passwords' },
  { key: 'admin.users.2fa_reset', description: 'Reset user 2FA' },
  { key: 'admin.users.ban', description: 'Ban users' },
  { key: 'admin.users.unban', description: 'Unban users' },
  { key: 'admin.users.export', description: 'Export users' },
  { key: 'admin.models.view', description: 'View models' },
  { key: 'admin.models.edit', description: 'Create or edit models' },
  { key: 'admin.api_keys.view', description: 'View API keys' },
  { key: 'admin.api_keys.edit', description: 'Edit API key scopes and status' },
  { key: 'admin.api_keys.revoke', description: 'Revoke API keys' },
  { key: 'admin.matches.view', description: 'View matches' },
  { key: 'admin.matches.cancel', description: 'Cancel matches' },
  { key: 'admin.matches.retry', description: 'Retry matches' },
  { key: 'admin.queue.view', description: 'View queue' },
  { key: 'admin.queue.retry', description: 'Retry queue jobs' },
  { key: 'admin.queue.clean', description: 'Clean queue' },
  { key: 'admin.analytics.view', description: 'View analytics' },
  { key: 'admin.analytics.edit', description: 'Edit analytics layout' },
  { key: 'admin.media.view', description: 'View media library' },
  { key: 'admin.media.upload', description: 'Upload media' },
  { key: 'admin.media.delete', description: 'Delete media' },
  { key: 'admin.content.view', description: 'View content' },
  { key: 'admin.content.edit', description: 'Edit content' },
  { key: 'admin.games.view', description: 'View game builder' },
  { key: 'admin.games.edit', description: 'Edit game definitions' },
  { key: 'admin.games.publish', description: 'Publish or schedule games' },
  { key: 'admin.settings.view', description: 'View system settings' },
  { key: 'admin.settings.edit', description: 'Edit system settings' },
  { key: 'admin.settings.force_logout', description: 'Force logout all users' },
  { key: 'admin.settings.audit_export', description: 'Export audit log' },
  { key: 'admin.comms.test', description: 'Send comms test messages' },
  { key: 'admin.audit.view', description: 'View admin audit log' },
  { key: 'admin.audit.export', description: 'Export admin audit log' },
  { key: 'admin.approvals.view', description: 'View access requests' },
  { key: 'admin.approvals.edit', description: 'Approve or deny access requests' },
  { key: 'admin.rbac.view', description: 'View RBAC configuration' },
  { key: 'admin.rbac.edit', description: 'Edit RBAC configuration' },
  { key: 'admin.entitlements.view', description: 'View subscription entitlements' },
  { key: 'admin.entitlements.edit', description: 'Edit subscription entitlements' },
  { key: 'admin.plans.view', description: 'View subscription plans' },
  { key: 'admin.plans.edit', description: 'Edit subscription plans' },
  { key: 'admin.hr.view', description: 'View HR console' },
  { key: 'admin.hr.edit', description: 'Manage HR jobs and applications' },
  { key: 'admin.chat.manage', description: 'Manage chat channels and settings' },
  { key: 'admin.chat.broadcast', description: 'Broadcast system-wide alerts' },
  { key: 'admin.settings.chat_config', description: 'Configure which chat settings users can manage' },
  { key: 'admin.users.chat_settings', description: 'Modify chat settings for specific users' },
  { key: 'admin.ai_chat.access', description: 'Access administrative AI assistant' },
  { key: 'admin.ai_chat.query', description: 'Interact with administrative AI assistant' },
  { key: 'admin.ai_chat.export', description: 'Export administrative AI chat logs' }
];

type PermissionEffect = 'ALLOW' | 'DENY';

const splitPermissions = (entries: { key: string; effect: PermissionEffect }[]) => {
  const allow = new Set<string>();
  const deny = new Set<string>();
  entries.forEach(entry => {
    if (entry.effect === 'DENY') deny.add(entry.key);
    else allow.add(entry.key);
  });
  return { allow, deny };
};

export const getPermissionEvaluator = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });

  const [userRoles, userGroups, overrides] = await Promise.all([
    prisma.rbacUserRole.findMany({ where: { user_id: userId }, select: { role_id: true } }),
    prisma.rbacUserGroup.findMany({ where: { user_id: userId }, select: { group_id: true } }),
    prisma.rbacUserPermissionOverride.findMany({
      where: { user_id: userId },
      include: { permission: { select: { key: true } } }
    })
  ]);

  const userRoleIds = userRoles.map(r => r.role_id);
  const groupIds = userGroups.map(g => g.group_id);
  const groupRoleIds = groupIds.length
    ? (await prisma.rbacGroupRole.findMany({ where: { group_id: { in: groupIds } }, select: { role_id: true } })).map(r => r.role_id)
    : [];

  const [userRolePerms, groupRolePerms] = await Promise.all([
    userRoleIds.length
      ? prisma.rbacRolePermission.findMany({
          where: { role_id: { in: userRoleIds } },
          include: { permission: { select: { key: true } } }
        })
      : Promise.resolve([]),
    groupRoleIds.length
      ? prisma.rbacRolePermission.findMany({
          where: { role_id: { in: groupRoleIds } },
          include: { permission: { select: { key: true } } }
        })
      : Promise.resolve([])
  ]);

  const overridesSplit = splitPermissions(
    overrides.map(o => ({ key: o.permission.key, effect: o.effect as PermissionEffect }))
  );
  const userRoleSplit = splitPermissions(
    userRolePerms.map(p => ({ key: p.permission.key, effect: p.effect as PermissionEffect }))
  );
  const groupRoleSplit = splitPermissions(
    groupRolePerms.map(p => ({ key: p.permission.key, effect: p.effect as PermissionEffect }))
  );

  const hasAssignments =
    userRoleIds.length > 0 || groupRoleIds.length > 0 || overrides.length > 0;

  const can = (perm: string) => {
    if (!hasAssignments && user?.role === 'ADMIN') return true;
    if (overridesSplit.deny.has(perm)) return false;
    if (overridesSplit.allow.has(perm)) return true;
    if (groupRoleSplit.deny.has(perm)) return false;
    if (groupRoleSplit.allow.has(perm)) return true;
    if (userRoleSplit.deny.has(perm)) return false;
    if (userRoleSplit.allow.has(perm)) return true;
    return false;
  };

  const effective = RBAC_PERMISSIONS.filter(p => can(p.key)).map(p => p.key);

  return { can, effective };
};
