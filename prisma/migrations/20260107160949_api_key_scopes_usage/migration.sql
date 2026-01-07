-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "prefix" TEXT,
ADD COLUMN     "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "ApiKeyScope" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyUsage" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKeyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKeyAuditLog" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_key_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyScope_scope_key_idx" ON "ApiKeyScope"("scope_key");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyScope_key_id_scope_key_key" ON "ApiKeyScope"("key_id", "scope_key");

-- CreateIndex
CREATE INDEX "ApiKeyUsage_key_id_window_start_idx" ON "ApiKeyUsage"("key_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyUsage_key_id_route_method_status_code_window_start_key" ON "ApiKeyUsage"("key_id", "route", "method", "status_code", "window_start");

-- CreateIndex
CREATE INDEX "ApiKeyAuditLog_target_key_id_created_at_idx" ON "ApiKeyAuditLog"("target_key_id", "created_at");

-- AddForeignKey
ALTER TABLE "ApiKeyScope" ADD CONSTRAINT "ApiKeyScope_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyUsage" ADD CONSTRAINT "ApiKeyUsage_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyAuditLog" ADD CONSTRAINT "ApiKeyAuditLog_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyAuditLog" ADD CONSTRAINT "ApiKeyAuditLog_target_key_id_fkey" FOREIGN KEY ("target_key_id") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
