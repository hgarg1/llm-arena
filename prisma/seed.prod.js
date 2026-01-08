"use strict";

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const { RBAC_PERMISSIONS } = require("../dist/constants/rbac-permissions");

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@llmarena.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const adminTier = process.env.ADMIN_TIER || "ENTERPRISE";

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const permissionMap = {};
  for (const perm of RBAC_PERMISSIONS) {
    const permission = await prisma.rbacPermission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
    permissionMap[perm.key] = permission.id;
  }

  const upsertRole = async (name, description, allow) => {
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
        data: { role_id: role.id, permission_id: permId, effect: "ALLOW" }
      });
    }
    return role;
  };

  const allPerms = RBAC_PERMISSIONS.map((p) => p.key);
  const superAdminRole = await upsertRole("SuperAdmin", "Full access", allPerms);
  const contentAdminRole = await upsertRole("ContentAdmin", "Content and media management", [
    "admin.access",
    "admin.dashboard.view",
    "admin.content.view",
    "admin.content.edit",
    "admin.media.view",
    "admin.media.upload",
    "admin.media.delete"
  ]);
  const supportAdminRole = await upsertRole("SupportAdmin", "User support and account actions", [
    "admin.access",
    "admin.dashboard.view",
    "admin.users.view",
    "admin.users.edit",
    "admin.users.password_reset",
    "admin.users.2fa_reset",
    "admin.users.ban",
    "admin.users.unban",
    "admin.chat.manage"
  ]);
  const opsAdminRole = await upsertRole("OpsAdmin", "Operations and queue management", [
    "admin.access",
    "admin.dashboard.view",
    "admin.matches.view",
    "admin.matches.cancel",
    "admin.matches.retry",
    "admin.queue.view",
    "admin.queue.retry",
    "admin.queue.clean",
    "admin.analytics.view",
    "admin.chat.manage",
    "admin.chat.broadcast",
    "admin.settings.chat_config",
    "admin.users.chat_settings",
    "admin.ai_chat.access",
    "admin.ai_chat.query"
  ]);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      email_verified: true,
      email_verification_token: null
    },
    create: {
      email: adminEmail,
      password_hash: passwordHash,
      role: "ADMIN",
      tier: adminTier,
      email_verified: true
    }
  });

  await prisma.rbacUserRole.upsert({
    where: { user_id_role_id: { user_id: admin.id, role_id: superAdminRole.id } },
    update: {},
    create: { user_id: admin.id, role_id: superAdminRole.id }
  });

  const supportGroup = await prisma.rbacGroup.upsert({
    where: { name: "Support" },
    update: {},
    create: { name: "Support", description: "Support group" }
  });
  const contentGroup = await prisma.rbacGroup.upsert({
    where: { name: "Content" },
    update: {},
    create: { name: "Content", description: "Content group" }
  });
  const opsGroup = await prisma.rbacGroup.upsert({
    where: { name: "Ops" },
    update: {},
    create: { name: "Ops", description: "Operations group" }
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

  console.log({
    adminEmail,
    rolesSeeded: [superAdminRole.name, contentAdminRole.name, supportAdminRole.name, opsAdminRole.name]
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
