-- CreateEnum
CREATE TYPE "GameEngineArtifactStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "GameEngineArtifact" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "status" "GameEngineArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "spec" JSONB NOT NULL,
    "code_ts" TEXT NOT NULL,
    "tests_ts" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameEngineArtifact_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "GameEngineArtifact" ADD CONSTRAINT "GameEngineArtifact_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "GameDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
