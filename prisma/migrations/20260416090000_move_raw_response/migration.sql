-- Raw provider responses for model moves (docs/INTEGRITY_SPEC.md 5.2). Scrubbed of credentials before they get here,
-- capped at 64 KiB, and deletable by retention: the move's provenance carries the digest of the full response.
CREATE TABLE "MoveRawResponse" (
    "match_id" TEXT NOT NULL,
    "move_index" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoveRawResponse_pkey" PRIMARY KEY ("match_id","move_index")
);

CREATE INDEX "MoveRawResponse_created_at_idx" ON "MoveRawResponse"("created_at");

ALTER TABLE "MoveRawResponse" ADD CONSTRAINT "MoveRawResponse_match_id_move_index_fkey" FOREIGN KEY ("match_id", "move_index") REFERENCES "MatchMove"("match_id", "move_index") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma does not model CHECK constraints; these keep the table honest even for a writer that bypasses the application.
ALTER TABLE "MoveRawResponse"
  ADD CONSTRAINT "MoveRawResponse_size_limit_chk" CHECK (octet_length("body") <= 65536),
  ADD CONSTRAINT "MoveRawResponse_sha256_format_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "MoveRawResponse_bytes_chk" CHECK ("bytes" >= 0),
  -- an untruncated copy is the whole response; a truncated one is a shorter prefix of it
  ADD CONSTRAINT "MoveRawResponse_truncation_chk" CHECK (("truncated" AND octet_length("body") <= "bytes") OR (NOT "truncated" AND octet_length("body") = "bytes"));
