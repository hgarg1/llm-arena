-- AlterTable
ALTER TABLE "ChatChannel" ADD COLUMN     "is_read_only" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rate_limit" INTEGER NOT NULL DEFAULT 0;
