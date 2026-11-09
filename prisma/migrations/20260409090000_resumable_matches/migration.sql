-- Lease + counters for resumable match execution.
ALTER TABLE "Match"
ADD COLUMN "lease_owner" TEXT,
ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "slice_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "move_failures" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Match_status_lease_expires_at_idx" ON "Match"("status", "lease_expires_at");

-- Durable move log used to replay a match in a new process.
CREATE TABLE "MatchMove" (
  "id" TEXT NOT NULL,
  "match_id" TEXT NOT NULL,
  "move_index" INTEGER NOT NULL,
  "actor_role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchMove_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MatchMove_match_id_move_index_key" ON "MatchMove"("match_id", "move_index");
ALTER TABLE "MatchMove" ADD CONSTRAINT "MatchMove_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
