-- Per-move provenance (docs/INTEGRITY_SPEC.md): where a move came from and which prompt, model and sampling settings produced it.
-- Nullable: moves recorded before this migration keep NULL ("not recorded"). The signed manifest commits to these values.
ALTER TABLE "MatchMove" ADD COLUMN "provenance" JSONB;
ALTER TABLE "MatchMove" ADD CONSTRAINT "MatchMove_provenance_object_chk" CHECK ("provenance" IS NULL OR jsonb_typeof("provenance") = 'object');
