/**
 * The no-fork migration: within one match an event has at most one successor, so a hash chain cannot fork.
 * Replayed on PGlite on top of existing data (see scripts/pglite-replay.mjs).
 */
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.join(__dirname, '..');
const NEW = '20260413090000_match_event_chain_no_fork';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

type Step = { sql: string; params?: unknown[] };
const match = (id: string): Step => ({ sql: `INSERT INTO "Match" ("id", "game_type", "seed") VALUES ($1, 'chess', 42)`, params: [id] });
const legacy = (matchId: string, seq: number): Step => ({
  sql: `INSERT INTO "MatchEvent" ("id", "match_id", "turn_index", "seq", "actor_role", "type", "payload") VALUES (gen_random_uuid()::text, $1, $2, $2, 'system', 'STEP', '{}'::jsonb)`,
  params: [matchId, seq]
});
const chained = (matchId: string, seq: number, hash: string, prev: string): Step => ({
  sql: `INSERT INTO "MatchEvent" ("id", "match_id", "turn_index", "seq", "actor_role", "type", "payload", "hash", "prev_hash") VALUES (gen_random_uuid()::text, $1, $2, $2, 'system', 'STEP', '{}'::jsonb, $3, $4)`,
  params: [matchId, seq, hash, prev]
});

const checks: { key: string; step: Step }[] = [
  { key: 'legacy-count', step: { sql: `SELECT count(*)::int AS n FROM "MatchEvent" WHERE "match_id" = 'legacy'` } },
  { key: 'legacy-more', step: legacy('legacy', 2) },                       // more unchained events: NULLs never collide
  { key: 'm-chain', step: match('chain') },
  { key: 'first', step: chained('chain', 0, B, A) },                       // A -> B
  { key: 'second', step: chained('chain', 1, C, B) },                      // B -> C
  { key: 'fork', step: chained('chain', 1, A, B) },                        // a second successor of B: rejected
  { key: 'duplicate-successor-of-genesis', step: chained('chain', 0, C, A) },
  { key: 'm-other', step: match('other') },
  { key: 'same-prev-other-match', step: chained('other', 0, B, A) },       // the same prev_hash in another match is fine
  { key: 'count', step: { sql: `SELECT count(*)::int AS n FROM "MatchEvent" WHERE "match_id" = 'chain'` } },
  { key: 'index', step: { sql: `SELECT indexdef FROM pg_indexes WHERE indexname = 'MatchEvent_match_id_prev_hash_key'` } }
];

describe('migration: a match event has at most one successor', () => {
  let out: Record<string, { ok: boolean; rows?: any[]; error?: string }>;

  beforeAll(() => {
    const run = spawnSync(process.execPath, ['scripts/pglite-replay.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ target: NEW, setup: [match('legacy'), legacy('legacy', 0), legacy('legacy', 1)], checks: checks.map(c => c.step) })
    });
    if (run.status !== 0) throw new Error(`replay failed: ${String(run.stderr).slice(-600)}`);
    const { results } = JSON.parse(run.stdout);
    out = Object.fromEntries(checks.map((c, i) => [c.key, results[i]]));
  }, 150_000);

  it('applies on top of existing unchained events, which remain readable', () => {
    expect(out['legacy-count'].rows).toEqual([{ n: 2 }]);
  });

  it('never blocks unchained (NULL prev_hash) events, however many a match has', () => {
    expect(out['legacy-more'].ok).toBe(true);
  });

  it('accepts a chain being extended one event at a time', () => {
    expect(out.first.ok).toBe(true);
    expect(out.second.ok).toBe(true);
  });

  it('rejects a second successor of the same event, which is what a fork would be', () => {
    expect(out.fork.ok).toBe(false);
    expect(out.fork.error).toContain('MatchEvent_match_id_prev_hash_key');
    expect(out['duplicate-successor-of-genesis'].ok).toBe(false);
    expect(out.count.rows).toEqual([{ n: 2 }]);
  });

  it('is scoped to one match: the same prev_hash in another match is fine', () => {
    expect(out['same-prev-other-match'].ok).toBe(true);
  });

  it('is a unique index on (match_id, prev_hash)', () => {
    expect(out.index.rows![0].indexdef).toMatch(/UNIQUE INDEX .*\(match_id, prev_hash\)/);
  });
});
