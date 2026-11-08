-- Per-match accounting used by budgets and the runner dashboard.
ALTER TABLE "Match"
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "input_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "output_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rate_limit_waits" INTEGER NOT NULL DEFAULT 0;

-- Per-move provider, latency and cost.
ALTER TABLE "MatchMove"
ADD COLUMN "provider" TEXT,
ADD COLUMN "latency_ms" INTEGER,
ADD COLUMN "input_tokens" INTEGER,
ADD COLUMN "output_tokens" INTEGER;
CREATE INDEX "MatchMove_provider_created_at_idx" ON "MatchMove"("provider", "created_at");

-- Shared token buckets for provider rate limiting across all runners.
CREATE TABLE "ProviderRateLimit" (
  "key" TEXT NOT NULL,
  "tokens" DOUBLE PRECISION NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ProviderRateLimit_pkey" PRIMARY KEY ("key")
);
