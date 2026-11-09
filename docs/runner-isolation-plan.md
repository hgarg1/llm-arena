# Running each game in its own runner — plan

> **Status: phases 1, 2 and 3 are implemented.** Operations guide: `vercel-runner.md`. Differences from the original design: slices are chained by an authenticated self-dispatch (the slice function answers `202` and continues via `waitUntil`) with the cron sweeper as the safety net, rather than Vercel Workflow/Queues, because those need SDKs that could not be exercised locally; the driver sits behind `startMatch`, so swapping it later touches one file. Phase 3 is implemented too (shared provider token buckets, 429 handling, per-match budgets, usage accounting, structured metrics and the Runner Health page); see `vercel-runner.md`.

Goal: a match run must never compete with page requests for CPU, memory, DB connections or
function concurrency, and the plan must work on **Vercel alone**, with Render (or similar) as an
optional add-on rather than a requirement. Existing architecture stays: Express app, Prisma/Postgres,
`runMatch` as the single execution core, BullMQ path kept for the Docker/VM deployment.

## 1. Where things stand (verified in the repo)

| Fact | Evidence | Consequence |
|---|---|---|
| Web on Vercel is a serverless Express app | `vercel.json`, `api/index.js` (`createApp({ io: null })`) | No long-lived process, no sockets, no in-process worker |
| Matches only execute through BullMQ + Redis | `src/config/runtime.ts` (`isQueueEnabled` needs `MATCH_QUEUE_ENABLED` and `REDIS_URL`), `src/worker.ts` | **On Vercel today a created match stays `PENDING`** unless a worker elsewhere (the GCE VM in `docker-compose.yml`) shares the DB and Redis. The create page already shows "worker-backed execution is currently paused". |
| `runMatch` is one long loop | `src/services/match-runner.service.ts` | A chess match is up to ~200 LLM calls; far beyond one function invocation |
| Engines are stateful in-memory objects | `GameEngine` contract | A run cannot simply be resumed; it must be **replayed** |
| Already done (this branch) | sandbox worker threads, atomic status transitions, cancel, idempotent restarts, `seq`-ordered events | The pieces a runner needs exist |

Vercel limits to design against (from Vercel docs; confirm the exact figures for your plan before committing):
function duration is configurable up to several minutes (docs list 800s on Pro, with longer ceilings under
Fluid compute); cron is per-minute on Pro but **once per day on Hobby**; Vercel Queues and Workflow
(durable, resumable, built on Queues) exist and are the platform's answer to long work.
Sources: <https://vercel.com/docs/functions/limitations>, <https://vercel.com/docs/cron-jobs/usage-and-pricing>, <https://vercel.com/workflow>.

## 2. The key change: make a run resumable, not long

Everything else follows from one idea: **a match is executed in slices**. A slice is bounded
(for example 45 s of work, or one function's `maxDuration` minus margin). Between slices all state
is in Postgres, so any process — a Vercel function, a BullMQ worker, a container — can continue it.

### 2.1 Data model (one small migration)
- `MatchMove(match_id, move_index, actor_role, content, created_at)` with `UNIQUE(match_id, move_index)`:
  the raw text each player/system actor submitted. Events cannot be used for replay because they hold
  derived data, not the raw move.
- `Match.lease_owner TEXT`, `Match.lease_expires_at TIMESTAMPTZ`, `Match.slice_count INT`.

### 2.2 `runMatchSlice(matchId, { deadlineMs })` (refactor of `runMatch`, same file)
1. **Acquire lease** atomically: `UPDATE Match SET lease_owner=$me, lease_expires_at=now()+ttl WHERE id=$id AND status IN (PENDING,RUNNING) AND (lease_expires_at IS NULL OR lease_expires_at < now())`. Zero rows → another slice owns it; exit.
2. **Rebuild**: load match, `engine.initialize(seed, options)`, then replay the stored `MatchMove` rows through `processMove`. This is CPU only (milliseconds to a few seconds even for long games) and deterministic because engines are seeded. No events are written during replay.
3. **Continue**: loop exactly as today, but before starting a move check `Date.now() + worstCaseMoveMs < deadline`. For each move: write `MatchMove` and its `MatchEvent`s in one transaction (`seq` continues from the stored max), renew the lease.
4. **Finish or yield**: if the engine returns a result → same completion path as today (scores, `transitionStatus`). Otherwise release the lease and return `{ done: false }`.
5. The existing cancel check (status = `CANCELLED`) stays at the top of every move.

Crash behaviour: a slice that dies loses at most the one LLM call in flight; its lease expires and the next
slice replays and re-asks that move. `clearEvents` at start goes away (events are append-only now); the
BullMQ retry path simply calls `runMatchSlice` with an unbounded deadline, so its behaviour does not change.

Compatibility: matches created before the migration have no `MatchMove` rows; they keep running through the
current whole-run path (`runMatch`) — gate on `slice_count IS NULL`.

### 2.3 Engine requirement
Determinism is already required by the validation harness (setup check). Add one more check there:
*replaying the recorded moves reproduces identical events* (run a random game, record moves, replay on a fresh
instance, compare). This is what makes slicing safe for generated games.

## 3. Drivers: who calls `runMatchSlice`

A thin interface in front of today's `matchQueue.add` call in `MatchService.createMatch`:

```ts
interface MatchRunnerBackend {
  start(matchId: string): Promise<void>;     // enqueue first slice
  cancel?(matchId: string): Promise<void>;   // best effort; status check is the real stop
}
// MATCH_RUNNER=bullmq | vercel | inline
```

| Backend | Use | How |
|---|---|---|
| `bullmq` (today) | Docker/VM deployment, local dev | unchanged worker; calls `runMatchSlice` with no deadline |
| `vercel` | **Vercel only** | see below |
| `inline` | tests, `npm run dev` without Redis | awaits slices in-process |

### 3.1 The Vercel backend (recommended primary)
Preferred: **Vercel Workflow** — one durable workflow `playMatch(matchId)` whose body is
`while (!(await step(runSlice, matchId)).done) {}`. Retries, backoff, state persistence and observability come
from the platform; each step is a separate function execution bounded by `maxDuration`.

If Workflow is unavailable on your plan: **Vercel Queues** push-mode consumer at `/api/internal/match-slice`
that runs one slice and publishes the next message itself (consumer concurrency is configurable; the docs list the default as unlimited,
so set an explicit cap, see §5).

Either way add:
- **A separate function** for slices: `api/match-slice.js` (+ `vercel.json` route and `maxDuration`),
  distinct from `api/index.js`. Page traffic and match execution then have separate scaling, timeouts and
  memory settings and cannot starve each other.
- **A sweeper** at `/api/internal/sweep` on Vercel Cron (Pro: every minute): finds `PENDING` matches with no
  runner and `RUNNING` matches whose lease has expired, and restarts them. This heals any lost message and is the
  only driver needed if Queues/Workflow are not available (cron + `waitUntil` fan-out). Hobby cannot do this
  (daily cron), so plan for Pro.
- **Auth**: cron uses `CRON_SECRET`; queue/workflow routes verify the platform signature; manual calls need an HMAC.

### 3.2 Optional external container backend (Render/Fly/Cloud Run Jobs)
Only worth adding if one of these becomes true: matches routinely exceed what slicing handles comfortably, you
want per-run CPU/memory caps and an egress allow-list for generated code, or Vercel costs for long I/O waits
dominate. Shape: the same `runMatchSlice` code in the existing Docker image (`CMD node dist/runner.js <matchId>`),
launched one-per-match by the backend, with a hard timeout and `--memory`/`--cpus` limits, egress limited to the
model-provider hosts, and no database credentials beyond a role that can only touch `Match*` tables. The
Dockerfile and `docker-compose.yml` already build and run this image, so this is a launcher plus a role, not a
new architecture. Render is a reasonable host for the always-on BullMQ worker variant if you prefer that to Jobs.

## 4. Isolation of the run itself
- **Generated engine code**: already inside a worker thread with heap limits and a hard kill (`src/game/sandbox.ts`).
  On Vercel it runs inside the slice function, never inside the web function.
- **Admin validation / dry run** currently runs in the web function and blocks its event loop while an engine
  call is in flight (bounded at ~2.5 s per call, stops after the first stall). Move it behind the same slice route
  (`/api/internal/validate`, admin-triggered) so the page-serving function never blocks.
- **Per-run budgets** enforced in the runner, not the model adapter: max moves (exists), max wall time per match,
  max output tokens per move, max total spend per match → fail with a clear `failure_reason`.

## 5. Not choking the website (scale controls)
1. **Database connections**: serverless fan-out is the first thing that breaks. Use a pooled URL (PgBouncer/Neon/Supabase
   pooler or Prisma Accelerate), `connection_limit=1` per function, and a smaller pool on the slice function.
2. **Concurrency cap on slices** (queue consumer concurrency, or workflow concurrency) sized to
   `provider rate limit ÷ calls per match per second`; surplus matches wait as `PENDING`.
3. **Provider rate limiting**: a per-provider token bucket in Postgres (one row, atomic `UPDATE ... RETURNING`; reuse the same pattern as `reserveUsage`) so 200 matches cannot burst a provider into 429s.
4. **Replay page**: replace "reload all events every 3 s" with `GET /matches/:id/events?after=<seq>` (the `seq` column
   exists), `Cache-Control: no-store` while running and `public, s-maxage=31536000, immutable` for finished matches
   so the CDN serves completed replays and the origin only sees live ones.
5. **Backpressure in the UI**: show queue position / estimated wait on the match page; return a friendly 429 when
   pending matches exceed a threshold (per-user concurrency limit already exists via `matches.concurrent`).
6. **Fewer round trips**: one cancel-check query per move is fine; batch `MatchEvent` writes per move (done).

## 6. Rollout (each phase is shippable and reversible)
| Phase | Work | Done when |
|---|---|---|
| 0 (done) | Sandbox in worker threads, atomic status, cancel, idempotent restarts, `seq` ordering | tests green |
| 1 (done) | Migration (`MatchMove`, lease columns); `runMatchSlice` with deadline-aware attempts (60 s cap per attempt); **compact observations for chess/poker/blackjack (§9.4)**; BullMQ worker switched to it with no deadline; replay-determinism check in validation | existing tests pass; new tests: lease exclusivity, crash-resume equals uninterrupted run (same events/scores) for all 5 engines over 200 seeds, cancel mid-slice |
| 2 (done) | `MATCH_RUNNER=vercel`: slice function, Workflow or Queue driver, cron sweeper, internal auth; remove the "paused" banner when a runner is configured | a match created on a Vercel preview deploy completes with no VM; killing a slice mid-move still completes |
| 3 (done; load test run, see `load-test-2026-11-08.md`) | Pooled DB, slice concurrency cap, provider token bucket, incremental/cached events endpoint, per-match budgets, metrics (slice duration, resumes, provider 429s, queue depth) | load test: 200 concurrent matches while page p95 stays flat |
| 4 (optional) | Container backend for long or untrusted runs | only if triggered by §3.2 |

## 7. Test strategy
- Unit/integration (already runnable: `npm test`, `npm run test:db` on PGlite): add lease and replay tests in the
  existing runner suite; the DB suite already exercises the real repository and atomic SQL.
- Resume equivalence is the key property test: run N seeded games uninterrupted, and again with a forced yield
  every K moves; the persisted events and scores must be identical.
- Chaos: kill the slice at random points (throw after the move row is written but before events; after events but
  before lease release) and assert exactly-once events via the `UNIQUE(match_id, move_index)` and `seq`.
- Load: a script that creates M mock-provider matches and measures time-to-complete and web p95 (mock provider keeps
  cost at zero).

## 8. Decisions (resolved)
1. **Production runs on Vercel only.** The BullMQ/VM path stays for local dev and as a fallback, but nothing in production depends on it.
2. **Vercel Pro.** Per-minute cron and longer functions are available. Slice function `maxDuration` = 300 s (the Pro default; raising it toward the documented 800 s ceiling reduces slice counts roughly proportionally, see §9.3).
3. **Match length**: derived in §9 from the engines' real move counts and the runner's real timeouts.

## 9. Sizing math

### 9.1 Model calls per match (measured: 1,500 seeded simulations per row, random legal play; LLM play differs as noted)
| Game | Model calls per match | Notes |
|---|---|---|
| Chutes & Ladders | **0** (35 dice turns mean, p95 79, max 172) | automatic turns, CPU only, finishes in well under a second plus DB writes |
| Blackjack | 1 per seat (random play only stands); **LLM play with hits ≈ 2–3 per seat** | 3 seats ≈ 8 calls; 6 seats ≈ 15 |
| Texas Hold'em (one hand) | 2p: mean 6, max 12 · 3p: 10 / 20 · 4p: 14 / 28 · **6p: mean 21.5, p95 30, max 44** | LLMs raise and fold differently; use p95 × 1.5 (≈ 45) for 6 players |
| Chess | Hard cap **200 plies** (random play always reaches it). LLM play: typically **40–100 plies** before a mate or an illegal-move forfeit; assume typical 60, p95 150 | the cap, not the typical case, sizes worst-case spend |

### 9.2 Time per model call (what the runner enforces today)
- Adapter timeout 90 s per attempt, 3 attempts, backoff 1 s then 4 s: **one move can take up to 275 s**, nearly a whole 300 s function.
  So slicing must be deadline-aware: cap each attempt at 60 s and only retry while time remains in the slice; otherwise yield and let the next slice retry (count attempts on the move so it cannot loop forever).
- Typical latency L (assumption, to be replaced by measured data from Phase 3 metrics): fast models ≈ 2 s, standard ≈ 6 s, reasoning models ≈ 25 s.

### 9.3 Slices per match (slice = 300 s function; 15 s margin for cold start, lease, replay, final commit; 60 s move cap, so a new move may start until t = 225 s)
| Scenario | L = 2 s | L = 6 s | L = 25 s |
|---|---|---|---|
| Chess typical (60 plies) | 1 slice, 2 min | 2 slices, 6 min | 6 slices, 25 min |
| Chess p95 (150 plies) | 2 slices, 5 min | 4 slices, 15 min | 15 slices, 62 min |
| Chess cap (200 plies) | 2 slices, 7 min | 6 slices, 20 min | 20 slices, 83 min |
| Poker 6 players, typical (≈25 calls) | 1, 1 min | 1, 2.5 min | 3, 10 min |
| Poker 6 players, p95 (≈45) | 1, 1.5 min | 2, 4.5 min | 5, 19 min |
| Poker 2 players | 1, <1 min | 1, 1 min | 1, 3 min |
| Blackjack 3 seats | 1, <1 min | 1, 1 min | 1, 3 min |
| Chutes & Ladders | 1, <1 s | 1, <1 s | 1, <1 s |

Takeaways: only slow models on chess ever need many slices; **no single match needs more than ~20 slices even in the worst case**, and a slow-model chess run of 60–150 plies takes tens of minutes, which is fine because it is observable move by move. Replay cost per slice is small: ≈ 1–2 s even for a 200-move sandboxed engine (≈ 5 ms per sandbox call), and microseconds for built-ins.

### 9.4 The real bottleneck is prompt size, not slicing
Each call sends the **entire event history as JSON**; chess events carry two full FEN strings each. Measured: average **25 KB (≈ 7k tokens) per call over a 200-ply game**; total input per match grows with the square of the length:

| Chess plies | Full history sent (all calls) | Compact observation (SAN list + current FEN) |
|---|---|---|
| 60 | 440 KB ≈ 129k tokens | 16 KB ≈ 4.6k tokens |
| 150 | 2.7 MB ≈ 805k tokens | 79 KB ≈ 23k tokens |
| 200 | 4.9 MB ≈ 1.43M tokens | 134 KB ≈ 39k tokens |

That is a **36× reduction at 200 plies**. At 100 concurrent chess matches (L = 6 s) the current format needs ≈ **7.2 M input tokens per minute**, beyond most provider rate limits and the dominant cost, versus ≈ 0.2 M with compact observations. This must ship before the Vercel runner is opened to load.
Implementation: `ChessGame.getObservation` (hook already exists in the engine interface) returns `MATCH_START` + SAN move list + the current FEN; same idea for poker/blackjack (omit repeated stack/pot payloads). Because it changes what models see, bump `ruleset_version` for chess so old and new results are not compared.

### 9.5 Concurrency and load
| Concurrent matches (C), L = 6 s | Provider requests | Postgres | Function concurrency |
|---|---|---|---|
| 20 | 3.3 req/s (200/min) | ≈ 13 qps | 20 slices |
| 100 | 16.7 req/s (1,000/min) | ≈ 67 qps | 100 slices |
| 300 | 50 req/s (3,000/min) | ≈ 200 qps | 300 slices |

Postgres query rate is trivial at every level; the limits that matter are **connections** (each active slice holds one; needs a pooler beyond a few dozen) and **provider rate limits**. Start with a slice concurrency cap of **50**, a per-provider token bucket, and raise both from measured provider 429 rates.
Replay viewers: today each viewer re-downloads all events every 3 s (≈ 30 KB per poll for a 100-event match; 100 viewers ≈ 1 MB/s from the database). With `?after=seq` it becomes ≈ 0.3 KB per poll, and finished matches become CDN-cacheable.

### 9.6 Function-time budget (to confirm against your plan's included usage)
Wall time per match is the §9.3 minutes, mostly waiting on the provider. As an example, 1,000 typical chess matches per day at L = 6 s is ≈ 6,000 function-minutes (100 hours) per day of mostly idle waiting; whether idle I/O time is billed as full duration or as active CPU depends on Fluid compute pricing, so check it before launch. Active CPU is small (replay plus JSON; roughly 0.1–2 s per slice).
