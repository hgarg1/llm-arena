-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
