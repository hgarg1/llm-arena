import { prisma } from '../config/db';
import { RBAC_PERMISSIONS } from '../constants/rbac-permissions';

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
