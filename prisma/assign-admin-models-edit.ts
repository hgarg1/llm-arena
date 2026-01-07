import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2] || process.env.ADMIN_EMAIL || 'admin@llmarena.com';
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`User not found for email: ${email}`);
  }

  const permission = await prisma.rbacPermission.upsert({
    where: { key: 'admin.models.edit' },
    update: { description: 'Create or edit models' },
    create: { key: 'admin.models.edit', description: 'Create or edit models' }
  });

  await prisma.rbacUserPermissionOverride.upsert({
    where: { user_id_permission_id: { user_id: user.id, permission_id: permission.id } },
    update: { effect: 'ALLOW' },
    create: { user_id: user.id, permission_id: permission.id, effect: 'ALLOW' }
  });

  console.log(`Granted admin.models.edit to ${email}`);
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
