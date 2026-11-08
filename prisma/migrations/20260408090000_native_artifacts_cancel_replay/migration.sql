-- Admin cancellation is a real terminal state, distinct from FAILED.
ALTER TYPE "MatchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Built-in games become engine artifacts too, so every game resolves through one table.
CREATE TYPE "GameEngineArtifactKind" AS ENUM ('SANDBOXED', 'NATIVE');
ALTER TABLE "GameEngineArtifact"
ADD COLUMN "kind" "GameEngineArtifactKind" NOT NULL DEFAULT 'SANDBOXED',
ADD COLUMN "native_key" TEXT,
ADD COLUMN "contract_version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "GameEngineArtifact_native_key_idx" ON "GameEngineArtifact"("native_key");

-- Per-game replay presentation.
ALTER TABLE "GameUISchema" ADD COLUMN "replay_schema" JSONB;
