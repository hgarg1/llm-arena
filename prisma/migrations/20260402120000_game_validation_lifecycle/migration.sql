ALTER TABLE "GameEngineArtifact"
ADD COLUMN "compile_error" TEXT,
ADD COLUMN "compiled_at" TIMESTAMP(3);

ALTER TABLE "GameDryRun"
ADD COLUMN "engine_artifact_id" TEXT,
ADD COLUMN "success" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "error_message" TEXT;

CREATE INDEX "GameDryRun_game_id_created_at_idx" ON "GameDryRun"("game_id", "created_at");
CREATE INDEX "GameDryRun_engine_artifact_id_idx" ON "GameDryRun"("engine_artifact_id");

ALTER TABLE "GameDryRun"
ADD CONSTRAINT "GameDryRun_engine_artifact_id_fkey"
FOREIGN KEY ("engine_artifact_id") REFERENCES "GameEngineArtifact"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
