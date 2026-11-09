# Running matches on Vercel

Matches run as short **slices** in a dedicated function (`api/internal.js`), separate from the website
(`api/index.js`). State lives in Postgres; a slice rebuilds the engine by replaying the recorded moves,
plays until its time budget is nearly used, then yields. Design and sizing: `runner-isolation-plan.md`.

## How a match flows
1. `POST /matches` creates the match (`PENDING`) and the web function sends one signed request to
   `/api/internal/match-slice`, which answers `202` immediately (the page request never waits).
2. The slice function takes a **lease** on the match, replays the move log, and plays moves. Each move and
   its events are written in one transaction (`MatchMove` is unique per `(match, move_index)`, so a move can
   only ever be recorded once).
3. A model call only starts if its full timeout fits before the slice deadline. Otherwise the slice yields,
   releases the lease and dispatches the next slice (`continuation: true`).
4. **Vercel Cron** calls `/api/internal/sweep` every minute. It resumes `RUNNING` matches whose lease expired
   (a function died), starts `PENDING` matches while fewer than `MATCH_RUNNER_CONCURRENCY` are active, and fails
   `PENDING` matches older than `MATCH_PENDING_MAX_AGE_HOURS`.
5. Admin Cancel sets `CANCELLED`; the running slice sees it before its next move and stops.

If anything in step 1 or 3 is lost, step 4 repairs it within about a minute. Cron is best-effort and may
occasionally run twice; both are harmless because the lease makes the work idempotent.

## Configuration (Vercel project environment variables)
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MATCH_RUNNER` | yes | none | set to `vercel` |
| `MATCH_RUNNER_SECRET` | yes | none | HMAC secret for internal calls (random, 32+ chars). Fails closed when unset |
| `CRON_SECRET` | yes | none | Vercel sends it as `Authorization: Bearer ...` to the cron route |
| `MATCH_RUNNER_URL` | recommended | production domain | Public base URL used for dispatch. Use your custom domain so deployment protection cannot block it |
| `MATCH_RUNNER_CONCURRENCY` | no | 50 | Max matches running at once (admission control) |
| `MATCH_SLICE_MAX_DURATION_S` | no | 300 | Must not exceed `functions["api/internal.js"].maxDuration` in `vercel.json` |
| `MATCH_MOVE_TIMEOUT_MS` | no | 60000 | Cap per model call; shrunk automatically so one call fits in a slice |
| `MATCH_PENDING_MAX_AGE_HOURS` | no | 24 | Older `PENDING` matches are failed instead of started |
| `PROVIDER_RPM_<NAME>` | no | unlimited | Requests per minute allowed per provider, shared by every runner (e.g. `PROVIDER_RPM_OPENAI=500`; `<NAME>` is the provider uppercased, `z.ai` becomes `Z_AI`) |
| `PROVIDER_TPM_<NAME>` | no | unlimited | Estimated input tokens per minute per provider (e.g. `PROVIDER_TPM_ANTHROPIC=400000`) |
| `MATCH_MAX_WALL_MINUTES` | no | 240 | A match running longer than this (from its first start; queue wait excluded) is failed |
| `MATCH_MAX_INPUT_TOKENS` | no | 5000000 | A match that has sent more estimated input tokens than this is failed |
| `VERCEL_MIGRATE_ON_BUILD` | no | off | `true` makes production builds apply pending migrations (needs build machines to reach the database) |
| `DATABASE_URL` | yes | | Use a **pooled** connection string with `connection_limit=1` (serverless fan-out otherwise exhausts Postgres) |

Provider keys (`OPENAI_API_KEY`, ...) must be available to the slice function as well as the website.

## Protecting providers and budgets
- **Rate limits are shared.** Every slice takes tokens from a Postgres bucket per provider before calling the model, so
  100 concurrent matches cannot burst a provider into 429s. A bucket holds about five seconds of burst. Providers with no
  `PROVIDER_*` variable are not throttled by us.
- **Provider 429s are waited out, not failed.** The runner honours `Retry-After` (capped at 2 minutes), does not use up the
  move's retry budget, and yields if the wait will not fit in the current slice. Throttle waits are counted per match.
- **Budgets stop runaways.** A match over its time or token budget is failed (`MATCH_BUDGET_EXCEEDED` event, reason shown on
  the replay page and in the admin list) and is not retried automatically. Model output longer than 4,000 characters is
  truncated before it is stored or played.
- **Everything is measured.** Each move stores its provider, latency and estimated tokens; each match totals them. The admin
  **Runner Health** page (`/admin/runner`) shows running vs. cap, queue depth and oldest wait, orphaned matches, 24 h outcomes,
  budget failures, throttle waits and per-provider calls with p50/p95 latency. Structured JSON log lines (`match.slice`,
  `provider.call`, `provider.throttled`, `match.budget_exceeded`) go to the function logs, so a log drain can alert on them.

## `vercel.json` notes
- `functions` and `rewrites` are used instead of the legacy `builds`/`routes`: `maxDuration` can only be set through
  `functions`, and `functions` cannot be combined with `builds`.
- The internal function is `maxDuration: 300`. Raising it (up to your plan's maximum) means fewer slices per match;
  raise `MATCH_SLICE_MAX_DURATION_S` with it.
- Cron jobs run only on **production** deployments. On a preview, test by calling the endpoints directly.
- Memory is set in the project dashboard when Fluid compute is on (not in `vercel.json`).

## Rollout checklist
1. **Apply migrations first** (`prisma migrate deploy` against the production database). They are additive and old matches
   keep working, but the new code reads the new columns, so deploying before migrating breaks every query on `Match`.
   By default nothing in the Vercel build runs migrations. If Vercel's build machines can reach your database you can set
   `VERCEL_MIGRATE_ON_BUILD=true`: production builds then run `prisma migrate deploy` first (optionally through
   `MIGRATE_DATABASE_URL`/`DIRECT_URL` for a non-pooled connection) and a failed migration fails the build, leaving the
   previous deployment live. It is off by default because an IP-allowlisted database is unreachable from the builder.
2. Set the variables above, deploy a **preview**, and verify: `POST /api/internal/match-slice` with a bad signature
   returns 401; a signed call for a real match returns 202 and the match advances.
3. Promote to production, create a mock-provider match, watch it complete in the replay page.
4. Stale `PENDING` matches from before the runner existed are failed by the first sweep (24 h rule); an admin can retry
   any of them from the match list.
5. Load test with mock-provider matches (cost-free) before enabling real providers at scale.

## Local development
`MATCH_RUNNER=inline npm run dev` runs matches in the same process. `npm test` covers the runner, and
`npm run test:db` runs the same code against a real Postgres engine (PGlite) including lease races and the sweeper's SQL.

## Verified against Neon's pooler (2026-11-08)

The match log is written with interactive transactions (`recordMove`, `addEvents`: read the stored tail, then insert), and the runtime reaches Neon through the `-pooler` endpoint (PgBouncer, transaction mode, `pgbouncer=true`, `connection_limit=1` on Vercel). This was checked on a throwaway Neon branch of the production project, using the exact connection settings production uses:

- Both M1 migrations apply cleanly on Neon Postgres.
- An interactive transaction commits, and rolls back completely when it throws.
- Recording a move with its events takes about 100 to 150 ms at the median through the pooler.
- With 8 independent connections racing to record the same move, exactly one wins every time and the losers are rejected cleanly; 8 writers racing to append the same next event, at five positions in a row, also produce exactly one winner each time.
- 8 contending writers extended one chain to 40 events: 40 appended, 280 attempts rejected, and the final chain had no gap, repeat or fork and verified with the independent reference verifier.

Re-run it (use a throwaway branch, never production data; `neonctl branches create --name pooler-check --project-id <id>`, apply migrations to the branch with the direct URL, then delete the branch):

```
VERCEL=1 PARALLEL_CONNECTIONS=1 INTEGRATION_DATABASE_URL=<pooled branch url> \
  npx jest tests/integration/pooler.integration.test.ts
# the longer end-to-end tests need more time over the internet:
VERCEL=1 INTEGRATION_DATABASE_URL=<pooled branch url> \
  npx jest tests/integration/db.integration.test.ts --testTimeout=240000 -t "hash chain written through Postgres"
```

Neon branches inherit the parent's role passwords, so a branch connection string is as sensitive as production's. `neonctl branches create` prints the connection string; run it with its output redirected.

## Signing finished matches (milestone M1)

When `INTEGRITY_SIGNING_KEY` is set, every finished match gets a signed manifest (see `docs/INTEGRITY_SPEC.md` and `docs/INTEGRITY_KEYS.md`). The runner seals a match at the end of its last slice; the per-minute sweeper also seals recent finished matches that were missed (`INTEGRITY_SEAL_LOOKBACK_HOURS`, default 72). Apply the `MatchManifest` migration before enabling it. Without the variable nothing is signed and nothing changes.

### Raw provider responses and cost (milestone M1)

Every model move also stores the provider's raw response (scrubbed of credentials, at most 64 KiB, `MoveRawResponse` table), the token counts the provider reported, the measured latency and a computed cost. Apply the `MoveRawResponse` and `MatchMove.provenance` migrations before deploying. Settings:

Retention is an admin setting, not an environment variable: **Admin → Settings → Raw model response retention (days)** (`integrity_raw_retention_days`, default 90, `0` keeps them forever). The sweeper deletes older raw responses, the signed digests are unaffected, and the policy is published at `/data-retention`.

Cost needs a price list: `src/config/model-pricing.json` ships empty, so every cost is recorded as `unknown` until it is filled in from the providers' own price lists (entries are `{ provider, model_prefix, input_per_mtok, output_per_mtok }`; set `version` and `as_of`, commit, deploy). The rates applied are stored with each move, so a later price change never rewrites old costs.
