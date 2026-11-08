-- Match: persist the options a match was created with, the engine artifact it ran on, and why it failed.
ALTER TABLE "Match"
ADD COLUMN "options" JSONB,
ADD COLUMN "engine_artifact_id" TEXT,
ADD COLUMN "failure_reason" TEXT;

-- Scores can be fractional (draws are 0.5).
ALTER TABLE "MatchParticipant" ALTER COLUMN "score" TYPE DOUBLE PRECISION;

-- Deterministic event ordering inside a turn.
ALTER TABLE "MatchEvent" ADD COLUMN "seq" INTEGER NOT NULL DEFAULT 0;
UPDATE "MatchEvent" e
SET "seq" = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY turn_index, created_at, id) AS rn
  FROM "MatchEvent"
) ranked
WHERE ranked.id = e.id;
CREATE INDEX "MatchEvent_match_id_seq_idx" ON "MatchEvent"("match_id", "seq");

-- Dry run validation checklist.
ALTER TABLE "GameDryRun" ADD COLUMN "checks" JSONB;
