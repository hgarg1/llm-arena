-- AlterEnum
ALTER TYPE "CompositeStrategy" ADD VALUE 'PIPELINE';

-- CreateTable
CREATE TABLE "ModelPipelineStep" (
    "id" TEXT NOT NULL,
    "composite_id" TEXT NOT NULL,
    "member_model_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "prompt_template" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelPipelineStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelPipelineStep_composite_id_position_idx" ON "ModelPipelineStep"("composite_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPipelineStep_composite_id_member_model_id_key" ON "ModelPipelineStep"("composite_id", "member_model_id");

-- AddForeignKey
ALTER TABLE "ModelPipelineStep" ADD CONSTRAINT "ModelPipelineStep_composite_id_fkey" FOREIGN KEY ("composite_id") REFERENCES "ModelComposite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelPipelineStep" ADD CONSTRAINT "ModelPipelineStep_member_model_id_fkey" FOREIGN KEY ("member_model_id") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
