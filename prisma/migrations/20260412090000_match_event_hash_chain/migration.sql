-- Hash chain columns for tamper-evident match logs (docs/INTEGRITY_SPEC.md, arena-integrity/1).
-- Additive and nullable: existing events keep NULL and their matches are reported as "Unverified".
-- Nothing reads or writes these columns yet; the runner starts filling them in story m1-03.
ALTER TABLE "MatchEvent" ADD COLUMN "hash" VARCHAR(64),
ADD COLUMN "prev_hash" VARCHAR(64);

-- Hashes are 64 lowercase hex characters, and an event has both hashes or neither. Prisma does not model CHECK
-- constraints, so they live only here; `prisma migrate` leaves them alone.
ALTER TABLE "MatchEvent"
  ADD CONSTRAINT "MatchEvent_hash_format_chk" CHECK ("hash" IS NULL OR "hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "MatchEvent_prev_hash_format_chk" CHECK ("prev_hash" IS NULL OR "prev_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "MatchEvent_hash_pair_chk" CHECK (("hash" IS NULL) = ("prev_hash" IS NULL));
