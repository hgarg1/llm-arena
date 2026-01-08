-- AlterTable
ALTER TABLE "User" ADD COLUMN     "can_block_people" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "UserBlock" (
    "id" TEXT NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBlock_blocker_id_idx" ON "UserBlock"("blocker_id");

-- CreateIndex
CREATE INDEX "UserBlock_blocked_id_idx" ON "UserBlock"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlock_blocker_id_blocked_id_key" ON "UserBlock"("blocker_id", "blocked_id");

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
