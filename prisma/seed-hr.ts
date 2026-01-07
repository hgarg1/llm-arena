import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const run = async () => {
  const email = process.env.HR_SEED_EMAIL || 'hr@llmarena.com';
  const password = process.env.HR_SEED_PASSWORD || 'ChangeMe123!';
  const roleName = 'HR Manager';
  const groupName = 'HR Team';

  const [role, group, hrPerms] = await Promise.all([
    prisma.rbacRole.upsert({
      where: { name: roleName },
      create: { name: roleName, description: 'HR management role' },
      update: {}
    }),
    prisma.rbacGroup.upsert({
      where: { name: groupName },
      create: { name: groupName, description: 'Human resources group' },
      update: {}
    }),
    prisma.rbacPermission.findMany({
      where: { key: { in: ['admin.hr.view', 'admin.hr.edit', 'admin.access'] } }
    })
  ]);

  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: group.id, role_id: role.id } },
    create: { group_id: group.id, role_id: role.id },
    update: {}
  });

  for (const perm of hrPerms) {
    await prisma.rbacRolePermission.upsert({
      where: { role_id_permission_id: { role_id: role.id, permission_id: perm.id } },
      create: { role_id: role.id, permission_id: perm.id, effect: 'ALLOW' },
      update: { effect: 'ALLOW' }
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      password_hash: hash,
      name: 'HR Admin',
      role: 'ADMIN',
      tier: 'ENTERPRISE'
    },
    update: {
      role: 'ADMIN'
    }
  });

  await prisma.rbacUserGroup.upsert({
    where: { user_id_group_id: { user_id: user.id, group_id: group.id } },
    create: { user_id: user.id, group_id: group.id },
    update: {}
  });

  console.log(`Seeded HR user ${email} in group ${groupName} with role ${roleName}.`);
};

run()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
