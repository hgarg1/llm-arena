-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateTable
CREATE TABLE "RbacRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RbacRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacPermission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RbacPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacRolePermission" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,

    CONSTRAINT "RbacRolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RbacGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacGroupRole" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "RbacGroupRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacUserRole" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "RbacUserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacUserGroup" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,

    CONSTRAINT "RbacUserGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacUserPermissionOverride" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,

    CONSTRAINT "RbacUserPermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RbacRole_name_key" ON "RbacRole"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RbacPermission_key_key" ON "RbacPermission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "RbacRolePermission_role_id_permission_id_key" ON "RbacRolePermission"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "RbacGroup_name_key" ON "RbacGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RbacGroupRole_group_id_role_id_key" ON "RbacGroupRole"("group_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "RbacUserRole_user_id_role_id_key" ON "RbacUserRole"("user_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "RbacUserGroup_user_id_group_id_key" ON "RbacUserGroup"("user_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "RbacUserPermissionOverride_user_id_permission_id_key" ON "RbacUserPermissionOverride"("user_id", "permission_id");

-- AddForeignKey
ALTER TABLE "RbacRolePermission" ADD CONSTRAINT "RbacRolePermission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "RbacRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacRolePermission" ADD CONSTRAINT "RbacRolePermission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "RbacPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacGroupRole" ADD CONSTRAINT "RbacGroupRole_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "RbacGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacGroupRole" ADD CONSTRAINT "RbacGroupRole_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "RbacRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserRole" ADD CONSTRAINT "RbacUserRole_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserRole" ADD CONSTRAINT "RbacUserRole_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "RbacRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserGroup" ADD CONSTRAINT "RbacUserGroup_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserGroup" ADD CONSTRAINT "RbacUserGroup_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "RbacGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserPermissionOverride" ADD CONSTRAINT "RbacUserPermissionOverride_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserPermissionOverride" ADD CONSTRAINT "RbacUserPermissionOverride_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "RbacPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
