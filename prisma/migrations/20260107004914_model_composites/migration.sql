-- CreateEnum
CREATE TYPE "ModelKind" AS ENUM ('SINGLE', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "CompositeStrategy" AS ENUM ('ROUND_ROBIN', 'RANDOM', 'FALLBACK');

-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" "ModelKind" NOT NULL DEFAULT 'SINGLE';

-- CreateTable
CREATE TABLE "ModelComposite" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "strategy" "CompositeStrategy" NOT NULL DEFAULT 'ROUND_ROBIN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelComposite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCompositeMember" (
    "id" TEXT NOT NULL,
    "composite_id" TEXT NOT NULL,
    "member_model_id" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModelCompositeMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelComposite_model_id_key" ON "ModelComposite"("model_id");

-- CreateIndex
CREATE INDEX "ModelCompositeMember_composite_id_position_idx" ON "ModelCompositeMember"("composite_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCompositeMember_composite_id_member_model_id_key" ON "ModelCompositeMember"("composite_id", "member_model_id");

-- AddForeignKey
ALTER TABLE "ModelComposite" ADD CONSTRAINT "ModelComposite_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCompositeMember" ADD CONSTRAINT "ModelCompositeMember_composite_id_fkey" FOREIGN KEY ("composite_id") REFERENCES "ModelComposite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCompositeMember" ADD CONSTRAINT "ModelCompositeMember_member_model_id_fkey" FOREIGN KEY ("member_model_id") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
