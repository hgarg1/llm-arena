import { PrismaClient } from '@prisma/client';
import { RBAC_PERMISSIONS } from '../src/services/rbac.service';

const prisma = new PrismaClient();

async function main() {
  const superAdmin = await prisma.rbacRole.upsert({
    where: { name: 'SuperAdmin' },
    update: { description: 'Full access' },
    create: { name: 'SuperAdmin', description: 'Full access' }
  });

  const permissionMap: Record<string, string> = {};
  for (const perm of RBAC_PERMISSIONS) {
    const permission = await prisma.rbacPermission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
    permissionMap[perm.key] = permission.id;
  }

  await prisma.rbacRolePermission.deleteMany({ where: { role_id: superAdmin.id } });
  for (const key of Object.keys(permissionMap)) {
    await prisma.rbacRolePermission.create({
      data: { role_id: superAdmin.id, permission_id: permissionMap[key], effect: 'ALLOW' }
    });
  }

  const admin = await prisma.user.findUnique({ where: { email: 'admin@llmarena.com' } });
  if (admin) {
    await prisma.rbacUserRole.upsert({
      where: { user_id_role_id: { user_id: admin.id, role_id: superAdmin.id } },
      update: {},
      create: { user_id: admin.id, role_id: superAdmin.id }
    });
  }

  console.log('SuperAdmin synced with all permissions', { adminFound: !!admin });
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
