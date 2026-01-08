import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@llmarena.com';
  console.log(`Fixing entitlements for ${email}...`);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error('User not found!');
    process.exit(1);
  }

  console.log(`User found: ${user.id} (${user.role})`);

  // 1. Ensure ADMIN role
  if (user.role !== 'ADMIN') {
    console.log('Promoting to ADMIN...');
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'ADMIN' }
    });
  }

  // 2. Grant Chat Access Override
  console.log('Granting chat.access override...');
  await prisma.entitlementOverride.upsert({
    where: {
        // Find existing override if any by filtering (since we don't have a unique constraint on user+key easily accessible via upsert `where` unless we query first, 
        // actually EntitlementOverride has index [target_type, target_id] and [entitlement_key], but no unique compound.
        // Wait, schema says: @@index([target_type, target_id]), @@index([entitlement_key]).
        // It does NOT have a unique constraint on target + key.
        // So I should use findFirst then update or create.
        id: 'placeholder-will-be-ignored-if-create' 
    },
    // Actually, since there is no unique constraint, upsert is hard.
    // I will delete existing overrides for this key/user and create new one.
    update: {},
    create: {
        target_type: 'USER',
        target_id: user.id,
        entitlement_key: 'chat.access',
        enabled: true,
        value: true,
        created_by: 'system-fix-script'
    }
  });
  
  // Correction: Prisma upsert requires a unique field in `where`. 
  // Since there is no unique constraint, I will use deleteMany + create.
}

async function run() {
    const email = 'admin@llmarena.com';
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        console.log('User not found');
        return;
    }

    // Clear existing overrides to be clean
    await prisma.entitlementOverride.deleteMany({
        where: {
            target_type: 'USER',
            target_id: user.id,
            entitlement_key: 'chat.access'
        }
    });

    // Create explict override
    await prisma.entitlementOverride.create({
        data: {
            target_type: 'USER',
            target_id: user.id,
            entitlement_key: 'chat.access',
            enabled: true,
            value: true,
            created_by: user.id
        }
    });

    console.log('Chat entitlements fixed for admin.');
}

run()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
