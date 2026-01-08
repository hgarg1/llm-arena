import { Request, Response } from 'express';
import { prisma } from '../../config/db';
import { Prisma } from '@prisma/client';
import { RBAC_PERMISSIONS } from '../../constants/rbac-permissions';
import { logAdminAction } from '../../services/audit.service';

const findUser = async (query?: string) => {
  if (!query) return null;
  const where = query.includes('@')
    ? { email: query }
    : { id: query };
  return prisma.user.findFirst({
    where,
    include: {
      rbac_roles: {
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } }
            }
          }
        }
      },
      rbac_groups: {
        include: {
          group: {
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: { include: { permission: true } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      rbac_permission_overrides: { include: { permission: true } }
    }
  });
};

const ensurePermissions = async () => {
  for (const perm of RBAC_PERMISSIONS) {
    await prisma.rbacPermission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
  }
  const superAdmin = await prisma.rbacRole.upsert({
    where: { name: 'SuperAdmin' },
    update: { description: 'Full access' },
    create: { name: 'SuperAdmin', description: 'Full access' }
  });
  const perms = await prisma.rbacPermission.findMany({ select: { id: true, key: true } });
  await prisma.rbacRolePermission.deleteMany({ where: { role_id: superAdmin.id } });
  for (const perm of perms) {
    await prisma.rbacRolePermission.create({
      data: { role_id: superAdmin.id, permission_id: perm.id, effect: 'ALLOW' }
    });
  }
};

const buildEffectivePermissions = (user: NonNullable<Awaited<ReturnType<typeof findUser>>>) => {
  const results: { key: string; effect: 'ALLOW' | 'DENY' | 'NONE'; source: string }[] = RBAC_PERMISSIONS.map(p => ({
    key: p.key,
    effect: 'NONE' as 'ALLOW' | 'DENY' | 'NONE',
    source: 'None'
  }));

  const overrides = new Map<string, { effect: 'ALLOW' | 'DENY'; source: string }>();
  user.rbac_permission_overrides.forEach(override => {
    overrides.set(override.permission.key, {
      effect: override.effect as 'ALLOW' | 'DENY',
      source: 'User override'
    });
  });

  const userRolePerms: { key: string; effect: 'ALLOW' | 'DENY'; source: string }[] = [];
  user.rbac_roles.forEach(ur => {
    ur.role.permissions.forEach(rp => {
      userRolePerms.push({
        key: rp.permission.key,
        effect: rp.effect as 'ALLOW' | 'DENY',
        source: `Role: ${ur.role.name}`
      });
    });
  });

  const groupRolePerms: { key: string; effect: 'ALLOW' | 'DENY'; source: string }[] = [];
  user.rbac_groups.forEach(ug => {
    ug.group.roles.forEach(gr => {
      gr.role.permissions.forEach(rp => {
        groupRolePerms.push({
          key: rp.permission.key,
          effect: rp.effect as 'ALLOW' | 'DENY',
          source: `Group: ${ug.group.name} / Role: ${gr.role.name}`
        });
      });
    });
  });

  const hasAssignments =
    user.rbac_roles.length > 0 ||
    user.rbac_groups.length > 0 ||
    user.rbac_permission_overrides.length > 0;

  if (!hasAssignments && user.role === 'ADMIN') {
    return results.map(entry => ({
      ...entry,
      effect: 'ALLOW' as const,
      source: 'Implicit ADMIN role'
    }));
  }

  const split = (entries: { key: string; effect: 'ALLOW' | 'DENY'; source: string }[]) => {
    const allow = new Map<string, string>();
    const deny = new Map<string, string>();
    entries.forEach(entry => {
      if (entry.effect === 'DENY') deny.set(entry.key, entry.source);
      else allow.set(entry.key, entry.source);
    });
    return { allow, deny };
  };

  const overrideSplit = split(
    Array.from(overrides.entries()).map(([key, value]) => ({ key, effect: value.effect, source: value.source }))
  );
  const groupSplit = split(groupRolePerms);
  const roleSplit = split(userRolePerms);

  return results.map(entry => {
    if (overrideSplit.deny.has(entry.key)) {
      return { ...entry, effect: 'DENY', source: overrideSplit.deny.get(entry.key) || 'User override' };
    }
    if (overrideSplit.allow.has(entry.key)) {
      return { ...entry, effect: 'ALLOW', source: overrideSplit.allow.get(entry.key) || 'User override' };
    }
    if (groupSplit.deny.has(entry.key)) {
      return { ...entry, effect: 'DENY', source: groupSplit.deny.get(entry.key) || 'Group role' };
    }
    if (groupSplit.allow.has(entry.key)) {
      return { ...entry, effect: 'ALLOW', source: groupSplit.allow.get(entry.key) || 'Group role' };
    }
    if (roleSplit.deny.has(entry.key)) {
      return { ...entry, effect: 'DENY', source: roleSplit.deny.get(entry.key) || 'Role' };
    }
    if (roleSplit.allow.has(entry.key)) {
      return { ...entry, effect: 'ALLOW', source: roleSplit.allow.get(entry.key) || 'Role' };
    }
    return entry;
  });
};

export const rbacDashboard = async (req: Request, res: Response) => {
  await ensurePermissions();
  const userQuery = (req.query.user_q as string | undefined) || '';
  const userWhere: Prisma.UserWhereInput = userQuery
    ? {
        OR: [
          { email: { contains: userQuery, mode: Prisma.QueryMode.insensitive } },
          { id: { contains: userQuery, mode: Prisma.QueryMode.insensitive } }
        ]
      }
    : {};
  const [roles, groups, permissions, users] = await Promise.all([
    prisma.rbacRole.findMany({
      orderBy: { name: 'asc' },
      include: { permissions: { include: { permission: true } } }
    }),
    prisma.rbacGroup.findMany({
      orderBy: { name: 'asc' },
      include: { roles: { include: { role: true } } }
    }),
    prisma.rbacPermission.findMany({ orderBy: { key: 'asc' } }),
    prisma.user.findMany({
      where: userWhere,
      take: 50,
      orderBy: { created_at: 'desc' },
      select: { id: true, email: true }
    })
  ]);

  const selectedUser = await findUser(req.query.user as string | undefined);
  const selectedRoleId = req.query.role as string | undefined;
  const selectedGroupId = req.query.group as string | undefined;

  const selectedRole = selectedRoleId
    ? roles.find(r => r.id === selectedRoleId)
    : roles[0];
  const selectedGroup = selectedGroupId
    ? groups.find(g => g.id === selectedGroupId)
    : groups[0];

  const selectedUserEffective = selectedUser ? buildEffectivePermissions(selectedUser) : [];
  const selectedUserHasAssignments = selectedUser
    ? selectedUser.rbac_roles.length > 0 ||
      selectedUser.rbac_groups.length > 0 ||
      selectedUser.rbac_permission_overrides.length > 0
    : false;

  res.render('admin/rbac/index', {
    title: 'RBAC',
    path: '/admin/rbac',
    roles,
    groups,
    permissions,
    users,
    selectedUser,
    selectedUserEffective,
    selectedUserHasAssignments,
    selectedRole,
    selectedGroup,
    userQuery,
    success: req.query.success,
    error: req.query.error
  });
};

export const createRole = async (req: Request, res: Response) => {
  const { name, description } = req.body;
  try {
    const role = await prisma.rbacRole.create({ data: { name, description } });
    await logAdminAction((req.session as any).userId, 'rbac.role.create', role.id, { name });
    res.redirect(`/admin/rbac?success=Role created&role=${role.id}`);
  } catch (err) {
    res.redirect('/admin/rbac?error=Failed to create role');
  }
};

export const updateRolePermissions = async (req: Request, res: Response) => {
  const { roleId } = req.params;
  const roleParam = req.body.role_id as string | undefined;
  const effectiveRoleId = roleParam || roleId;
  const role = await prisma.rbacRole.findUnique({ where: { id: effectiveRoleId } });
  if (!role) return res.redirect('/admin/rbac?error=Role not found');
  await ensurePermissions();

  const permissionKeys = await prisma.rbacPermission.findMany({ select: { key: true } });
  const permBody = (req.body && req.body.perm) || {};
  const getByPath = (obj: any, key: string) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj[key] !== undefined) return obj[key];
    const parts = key.split('.');
    let current = obj;
    for (const part of parts) {
      if (!current || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  };
  const getValue = (prefix: string, key: string) => {
    const direct = req.body[`${prefix}_${key}`];
    if (direct) return direct;
    const nested = req.body[prefix] && req.body[prefix][key];
    if (nested) return nested;
    return 'none';
  };
  const updates = permissionKeys
    .map(p => ({
      permissionKey: p.key,
      value: getByPath(permBody, p.key) || getValue('perm', p.key)
    }))
    .filter(p => p.value !== 'none');

  await prisma.$transaction(async tx => {
    await tx.rbacRolePermission.deleteMany({ where: { role_id: effectiveRoleId } });
    for (const update of updates) {
      const permission = await tx.rbacPermission.findUnique({ where: { key: update.permissionKey } });
      if (!permission) continue;
      await tx.rbacRolePermission.create({
        data: {
          role_id: effectiveRoleId,
          permission_id: permission.id,
          effect: update.value === 'deny' ? 'DENY' : 'ALLOW'
        }
      });
    }
  });

  await logAdminAction((req.session as any).userId, 'rbac.role.permissions.update', effectiveRoleId);
  res.redirect(`/admin/rbac?success=Role permissions updated&role=${effectiveRoleId}`);
};

export const createGroup = async (req: Request, res: Response) => {
  const { name, description } = req.body;
  try {
    const group = await prisma.rbacGroup.create({ data: { name, description } });
    await logAdminAction((req.session as any).userId, 'rbac.group.create', group.id, { name });
    res.redirect(`/admin/rbac?success=Group created&group=${group.id}`);
  } catch (err) {
    res.redirect('/admin/rbac?error=Failed to create group');
  }
};

export const updateGroupRoles = async (req: Request, res: Response) => {
  const { groupId } = req.params;
  const group = await prisma.rbacGroup.findUnique({ where: { id: groupId } });
  if (!group) return res.redirect('/admin/rbac?error=Group not found');

  const roleIds = Array.isArray(req.body.role_ids) ? req.body.role_ids : req.body.role_ids ? [req.body.role_ids] : [];

  await prisma.$transaction(async tx => {
    await tx.rbacGroupRole.deleteMany({ where: { group_id: groupId } });
    for (const roleId of roleIds) {
      await tx.rbacGroupRole.create({ data: { group_id: groupId, role_id: roleId } });
    }
  });

  await logAdminAction((req.session as any).userId, 'rbac.group.roles.update', groupId);
  res.redirect(`/admin/rbac?success=Group roles updated&group=${groupId}`);
};

export const updateUserAssignments = async (req: Request, res: Response) => {
  const { userId } = req.params;
  const roleIds = Array.isArray(req.body.role_ids) ? req.body.role_ids : req.body.role_ids ? [req.body.role_ids] : [];
  const groupIds = Array.isArray(req.body.group_ids) ? req.body.group_ids : req.body.group_ids ? [req.body.group_ids] : [];

  await prisma.$transaction(async tx => {
    await tx.rbacUserRole.deleteMany({ where: { user_id: userId } });
    await tx.rbacUserGroup.deleteMany({ where: { user_id: userId } });
    for (const roleId of roleIds) {
      await tx.rbacUserRole.create({ data: { user_id: userId, role_id: roleId } });
    }
    for (const groupId of groupIds) {
      await tx.rbacUserGroup.create({ data: { user_id: userId, group_id: groupId } });
    }
  });

  await logAdminAction((req.session as any).userId, 'rbac.user.assignments.update', userId);
  res.redirect(`/admin/rbac?success=User assignments updated&user=${userId}`);
};

export const updateUserOverrides = async (req: Request, res: Response) => {
  const { userId } = req.params;
  await ensurePermissions();

  const permissionKeys = await prisma.rbacPermission.findMany({ select: { key: true } });
  const overrideBody = (req.body && req.body.override) || {};
  const getByPath = (obj: any, key: string) => {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj[key] !== undefined) return obj[key];
    const parts = key.split('.');
    let current = obj;
    for (const part of parts) {
      if (!current || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  };
  const getValue = (prefix: string, key: string) => {
    const direct = req.body[`${prefix}_${key}`];
    if (direct) return direct;
    const nested = req.body[prefix] && req.body[prefix][key];
    if (nested) return nested;
    return 'none';
  };
  const updates = permissionKeys
    .map(p => ({
      permissionKey: p.key,
      value: getByPath(overrideBody, p.key) || getValue('override', p.key)
    }))
    .filter(p => p.value !== 'none');

  await prisma.$transaction(async tx => {
    await tx.rbacUserPermissionOverride.deleteMany({ where: { user_id: userId } });
    for (const update of updates) {
      const permission = await tx.rbacPermission.findUnique({ where: { key: update.permissionKey } });
      if (!permission) continue;
      await tx.rbacUserPermissionOverride.create({
        data: {
          user_id: userId,
          permission_id: permission.id,
          effect: update.value === 'deny' ? 'DENY' : 'ALLOW'
        }
      });
    }
  });

  await logAdminAction((req.session as any).userId, 'rbac.user.overrides.update', userId);
  res.redirect(`/admin/rbac?success=User overrides updated&user=${userId}`);
};
