ALTER TABLE "GameEngineArtifact"
ADD COLUMN "generation_provider" TEXT,
ADD COLUMN "used_fallback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "generation_error" TEXT;
