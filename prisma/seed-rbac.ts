import { PrismaClient } from '@prisma/client';
import { RBAC_PERMISSIONS } from '../src/services/rbac.service';

const prisma = new PrismaClient();

async function main() {
  const permissionMap: Record<string, string> = {};
  for (const perm of RBAC_PERMISSIONS) {
    const permission = await prisma.rbacPermission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
    permissionMap[perm.key] = permission.id;
  }

  const upsertRole = async (name: string, description: string, allow: string[]) => {
    const role = await prisma.rbacRole.upsert({
      where: { name },
      update: { description },
      create: { name, description }
    });

    await prisma.rbacRolePermission.deleteMany({ where: { role_id: role.id } });
    for (const key of allow) {
      const permId = permissionMap[key];
      if (!permId) continue;
      await prisma.rbacRolePermission.create({
        data: { role_id: role.id, permission_id: permId, effect: 'ALLOW' }
      });
    }
    return role;
  };

  const allPerms = RBAC_PERMISSIONS.map(p => p.key);
  const superAdminRole = await upsertRole('SuperAdmin', 'Full access', allPerms);
  const contentAdminRole = await upsertRole('ContentAdmin', 'Content and media management', [
    'admin.access',
    'admin.dashboard.view',
    'admin.content.view',
    'admin.content.edit',
    'admin.media.view',
    'admin.media.upload',
    'admin.media.delete'
  ]);
  const supportAdminRole = await upsertRole('SupportAdmin', 'User support and account actions', [
    'admin.access',
    'admin.dashboard.view',
    'admin.users.view',
    'admin.users.edit',
    'admin.users.password_reset',
    'admin.users.2fa_reset',
    'admin.users.ban',
    'admin.users.unban'
  ]);
  const opsAdminRole = await upsertRole('OpsAdmin', 'Operations and queue management', [
    'admin.access',
    'admin.dashboard.view',
    'admin.matches.view',
    'admin.matches.cancel',
    'admin.matches.retry',
    'admin.queue.view',
    'admin.queue.retry',
    'admin.queue.clean',
    'admin.analytics.view'
  ]);

  const supportGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Support' },
    update: {},
    create: { name: 'Support', description: 'Support group' }
  });
  const contentGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Content' },
    update: {},
    create: { name: 'Content', description: 'Content group' }
  });
  const opsGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Ops' },
    update: {},
    create: { name: 'Ops', description: 'Operations group' }
  });

  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: supportGroup.id, role_id: supportAdminRole.id } },
    update: {},
    create: { group_id: supportGroup.id, role_id: supportAdminRole.id }
  });
  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: contentGroup.id, role_id: contentAdminRole.id } },
    update: {},
    create: { group_id: contentGroup.id, role_id: contentAdminRole.id }
  });
  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: opsGroup.id, role_id: opsAdminRole.id } },
    update: {},
    create: { group_id: opsGroup.id, role_id: opsAdminRole.id }
  });

  console.log('RBAC seed complete');
  console.log({
    roles: [superAdminRole.name, contentAdminRole.name, supportAdminRole.name, opsAdminRole.name],
    groups: [supportGroup.name, contentGroup.name, opsGroup.name],
    permissions: RBAC_PERMISSIONS.length
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
