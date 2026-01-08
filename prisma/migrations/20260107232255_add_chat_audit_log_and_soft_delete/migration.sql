-- CreateEnum
CREATE TYPE "ChatAuditAction" AS ENUM ('EDIT', 'DELETE');

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChatAuditLog" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" "ChatAuditAction" NOT NULL,
    "old_content" TEXT,
    "new_content" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatAuditLog_message_id_idx" ON "ChatAuditLog"("message_id");

-- CreateIndex
CREATE INDEX "ChatAuditLog_actor_id_idx" ON "ChatAuditLog"("actor_id");

-- AddForeignKey
ALTER TABLE "ChatAuditLog" ADD CONSTRAINT "ChatAuditLog_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAuditLog" ADD CONSTRAINT "ChatAuditLog_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
