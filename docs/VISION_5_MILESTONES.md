# LLM Arena: five milestones to "evidence you can defend"

**Mission:** be the evaluation backbone for AI systems that act, so teams decide from replays instead of anecdotes.

**Where we are:** a strong match runner and replay product. Resumable runner on Vercel, an append-only `MatchMove` log, generated and sandboxed game engines, entitlements, a mobile-ready UI and a session layer. The load test used mock models only.

**What is missing:** the evidence is not yet *defensible*. Scores carry no uncertainty, "immutable" logs are mutable database rows, no official run on real models exists, only chat models can compete, and customers have no private workspace. Each milestone below removes one of those gaps. They are ordered by dependency: every milestone makes the next one believable.

Effort figures are rough, for a team of 2 to 3 engineers. Treat them as sizing, not a promise.

---

## Milestone 1: Make the evidence true (trust foundation)
*Why first: every later claim rests on it, and it is the cheapest real differentiator.*

**Scope**
- Hash-chain every match event (each event commits to the previous one). Sign a per-match manifest when the match ends.
- Capture full provenance per match: engine artifact hash and version, game settings, seed, prompt template and version, model id and provider version, sampling parameters, raw provider responses, tokens, latency and cost.
- A public "Verify this match" page and badge, plus a small offline CLI that re-checks a match export.
- Methodology page updated to say exactly what is and is not guaranteed.
- Clean up credibility risks: label the investor-relations section as a demo (or remove the fictional NYSE listing, filings, board and dividend history).

**Exit criteria**
- 100% of new matches carry a valid manifest; a tampered event fails verification.
- A third party can verify a match with the CLI and no access to our database.

**Effort:** about 3 to 4 weeks. **Risk:** storing raw provider responses needs retention and privacy rules, which should be decided up front.

---

## Milestone 2: Make the ratings defensible
*Why: a leaderboard without uncertainty is the anecdote we are trying to replace.*

**Scope**
- Rating engine with uncertainty (Bradley-Terry with bootstrap confidence intervals, or TrueSkill). Ratings are recomputed from signed manifests, so anyone can reproduce them.
- Paired seeds: every pairing plays both sides of the same seeded game. Add a matchmaking scheduler that spends games where uncertainty is highest.
- Minimum game count before a model is ranked. Show interval, games played and win rate on the leaderboard.
- Failure taxonomy: illegal moves, timeouts, provider errors, and how each is scored.
- Behavioral metrics v1: illegal-move rate, cooperation and betrayal rate, adaptation across a match, cost per rating point.

**Exit criteria**
- Rank order is stable under bootstrap resampling, or the leaderboard visibly shows ties.
- Rating method documented; ratings reproduce from exported manifests.

**Effort:** about 4 to 5 weeks. **Risk:** game choice drives variance. Some games may need more games per pair than budget allows.

---

## Milestone 3: First official season on real models
*Why: proves the protocol on the models people care about and produces the first citable output.*

**Scope**
- Versioned season protocol: games, settings, seed pools, budgets, model list, scoring.
- Held-out private seed pool alongside the public one, so models cannot be tuned to published games.
- Cost accounting and budgets per season; secure custody of provider keys.
- Provider terms review on publishing benchmark results.
- Validate the runner against real providers at realistic concurrency (the load test so far used mock models).
- Public season results page, methodology paper and reproducibility package.

**Exit criteria**
- At least 10 frontier models across at least 3 games, with confidence intervals, published.
- An outside party reproduces the ratings from the package.

**Effort:** about 4 to 6 weeks, plus provider spend. **Risk:** provider rate limits and cost; results other labs dispute.

---

## Milestone 4: Bring your own agent
*Why: the mission says "AI systems that act", which is more than chat models.*

**Scope**
- Agent protocol (observation in, action out) over HTTPS webhook, plus a Python and TypeScript SDK and an `arena` CLI to run locally and submit.
- Sandboxed execution and egress controls for external agents (SSRF protection, timeouts, resource limits). Reuse what the generated-engine sandbox already does.
- Submission flow with approval, agent versioning and rate limits; separate leaderboard categories for models and agents.
- Public docs (the current docs page is a stub) with a quickstart.

**Exit criteria**
- An external team goes from zero to a ranked submission in under an hour.
- Three design partners have submitted agents.

**Effort:** about 6 to 8 weeks. **Risk:** security of running or calling untrusted agents; keep tool-using agents out of scope until the sandbox is proven.

---

## Milestone 5: Teams product
*Why: this is what research, product and governance teams pay for.*

**Scope**
- Organizations and workspaces with roles; real SSO (the Google, Microsoft and Apple buttons are placeholders today).
- Private evaluations and private leaderboards.
- Regression tracking: "did v2 beat v1?", with a CI integration (GitHub Action) that fails a build on a significant drop.
- API with webhooks, data export, and a printable governance report built from signed manifests.
- Customer-visible audit log, retention controls, per-organization billing on top of the existing entitlements.

**Exit criteria**
- Design partners run evaluations in CI weekly.
- First paying organizations; SOC 2 readiness plan written.

**Effort:** about 8 to 10 weeks. **Risk:** scope creep; ship one workflow (CI regression) end to end before the rest.

---

## Cross-cutting, every milestone
- **Security and legal:** provider terms, key custody, data retention, vulnerability reporting.
- **Operations:** cost dashboards per season, alerting on runner failures, backups and restore drills.
- **Docs and honesty:** every public claim on the site must match what the system guarantees that day.

## Deliberately not now
- More games. Depth of evidence beats breadth of games until Milestone 3 is done.
- More UI polish beyond bugs. The interface is already ahead of the evidence behind it.
- Marketing-style investor content, until the company has real investors.

## Rough sequence
M1 → M2 → M3 are strictly ordered. M4 can start its SDK and protocol design during M3. M5 depends on M1 (signed exports) and M2 (comparisons with significance), so it should not start before M2 ships.
