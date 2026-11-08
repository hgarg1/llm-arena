-- Signed manifest of a finished match (docs/INTEGRITY_SPEC.md section 5). One row per match, present only while the
-- match is in a final state; deleting the match deletes it. Nothing reads it until the runner starts sealing (m1-04).
CREATE TABLE "MatchManifest" (
    "match_id" TEXT NOT NULL,
    "key_id" VARCHAR(16) NOT NULL,
    "manifest" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchManifest_pkey" PRIMARY KEY ("match_id")
);

ALTER TABLE "MatchManifest" ADD CONSTRAINT "MatchManifest_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
