-- CreateEnum
CREATE TYPE "EntitlementValueType" AS ENUM ('BOOL', 'NUMBER', 'STRING', 'ENUM', 'JSON');

-- CreateEnum
CREATE TYPE "EntitlementOverrideTarget" AS ENUM ('ORG', 'USER');

-- CreateEnum
CREATE TYPE "EntitlementAuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "UsageScopeType" AS ENUM ('USER', 'ORG', 'API_KEY', 'MODEL');

-- AlterTable
ALTER TABLE "SubscriptionEntitlement" ADD COLUMN     "default_value" JSONB,
ADD COLUMN     "validation_schema" JSONB,
ADD COLUMN     "value_type" "EntitlementValueType" NOT NULL DEFAULT 'BOOL';

-- AlterTable
ALTER TABLE "SubscriptionPlanEntitlement" ADD COLUMN     "value" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "org_id" TEXT;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementOverride" (
    "id" TEXT NOT NULL,
    "target_type" "EntitlementOverrideTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "value" JSONB,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntitlementOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementAuditLog" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_type" "EntitlementOverrideTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "action" "EntitlementAuditAction" NOT NULL,
    "before_value" JSONB,
    "after_value" JSONB,
    "before_enabled" BOOLEAN,
    "after_enabled" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitlementAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "scope_type" "UsageScopeType" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "EntitlementOverride_target_type_target_id_idx" ON "EntitlementOverride"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "EntitlementOverride_entitlement_key_idx" ON "EntitlementOverride"("entitlement_key");

-- CreateIndex
CREATE INDEX "EntitlementAuditLog_entitlement_key_created_at_idx" ON "EntitlementAuditLog"("entitlement_key", "created_at");

-- CreateIndex
CREATE INDEX "UsageCounter_entitlement_key_window_start_idx" ON "UsageCounter"("entitlement_key", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_scope_type_scope_id_entitlement_key_window_sta_key" ON "UsageCounter"("scope_type", "scope_id", "entitlement_key", "window_start");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_entitlement_key_fkey" FOREIGN KEY ("entitlement_key") REFERENCES "SubscriptionEntitlement"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementOverride" ADD CONSTRAINT "EntitlementOverride_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementAuditLog" ADD CONSTRAINT "EntitlementAuditLog_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntitlementAuditLog" ADD CONSTRAINT "EntitlementAuditLog_entitlement_key_fkey" FOREIGN KEY ("entitlement_key") REFERENCES "SubscriptionEntitlement"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_entitlement_key_fkey" FOREIGN KEY ("entitlement_key") REFERENCES "SubscriptionEntitlement"("key") ON DELETE CASCADE ON UPDATE CASCADE;
