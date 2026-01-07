-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "created_by_id" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar_url" TEXT;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
