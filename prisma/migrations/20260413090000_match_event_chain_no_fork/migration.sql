-- A hash chain must not fork: within one match, an event can have only one successor (docs/INTEGRITY_SPEC.md 4.4).
-- Two writers that read the same tail and append different events both carry the same prev_hash; the second insert
-- is rejected here and its transaction rolls back. Events without hashes (matches from before chaining existed) have
-- NULL prev_hash, and NULLs are distinct in a unique index, so they never collide.
CREATE UNIQUE INDEX "MatchEvent_match_id_prev_hash_key" ON "MatchEvent"("match_id", "prev_hash");
