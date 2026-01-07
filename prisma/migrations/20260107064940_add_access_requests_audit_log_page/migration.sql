-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "AdminAccessRequest" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,
    "path" TEXT,
    "method" TEXT,
    "reason" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAccessRequest_status_created_at_idx" ON "AdminAccessRequest"("status", "created_at");

-- CreateIndex
CREATE INDEX "AdminAccessRequest_permission_key_idx" ON "AdminAccessRequest"("permission_key");

-- AddForeignKey
ALTER TABLE "AdminAccessRequest" ADD CONSTRAINT "AdminAccessRequest_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAccessRequest" ADD CONSTRAINT "AdminAccessRequest_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
