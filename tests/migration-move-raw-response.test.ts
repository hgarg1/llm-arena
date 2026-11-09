/** The MoveRawResponse table, replayed on PGlite on top of existing moves (see scripts/pglite-replay.mjs). */
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.join(__dirname, '..');
const NEW = '20260416090000_move_raw_response';
const H = 'a'.repeat(64);
type Step = { sql: string; params?: unknown[] };
const match = (id: string): Step => ({ sql: `INSERT INTO "Match" ("id", "game_type", "seed") VALUES ($1, 'chess', 42)`, params: [id] });
const mv = (matchId: string, index: number): Step => ({ sql: `INSERT INTO "MatchMove" ("id", "match_id", "move_index", "actor_role", "content") VALUES (gen_random_uuid()::text, $1, $2, 'white', 'e2e4')`, params: [matchId, index] });
const raw = (matchId: string, index: number, body: string, bytes: number, truncated = false, sha = H): Step => ({
  sql: `INSERT INTO "MoveRawResponse" ("match_id", "move_index", "body", "bytes", "sha256", "truncated") VALUES ($1, $2, $3, $4, $5, $6)`, params: [matchId, index, body, bytes, sha, truncated]
});

const LIMIT = 65536;
const checks: { key: string; step: Step }[] = [
  { key: 'legacy', step: { sql: `SELECT count(*)::int AS n FROM "MatchMove" WHERE "match_id" = 'old'` } },
  { key: 'valid', step: raw('old', 0, '{"a":1}', 7) },
  { key: 'read', step: { sql: `SELECT "body", "bytes", "truncated", "created_at" IS NOT NULL AS has_time FROM "MoveRawResponse" WHERE "match_id" = 'old' AND "move_index" = 0` } },
  { key: 'duplicate', step: raw('old', 0, '{"a":1}', 7) },
  { key: 'no-move', step: raw('old', 9, '{}', 2) },
  { key: 'at-limit', step: raw('old', 1, 'x'.repeat(LIMIT), LIMIT) },
  { key: 'over-limit', step: raw('old', 2, 'x'.repeat(LIMIT + 1), LIMIT + 1) },
  { key: 'bad-sha', step: raw('old', 3, '{}', 2, false, 'XYZ') },
  { key: 'negative-bytes', step: raw('old', 4, '', -1) },
  { key: 'untruncated-wrong-size', step: raw('old', 5, '{"a":1}', 99) },
  { key: 'truncated-valid', step: raw('old', 6, 'x'.repeat(100), 500, true) },
  { key: 'truncated-longer-than-whole', step: raw('old', 7, 'x'.repeat(100), 50, true) },
  { key: 'multibyte-counts-bytes', step: raw('old', 8, '€€', 6) },
  { key: 'index', step: { sql: `SELECT indexdef FROM pg_indexes WHERE indexname = 'MoveRawResponse_created_at_idx'` } },
  { key: 'cascade-move', step: { sql: `DELETE FROM "MatchMove" WHERE "match_id" = 'old' AND "move_index" = 0` } },
  { key: 'after-move-delete', step: { sql: `SELECT count(*)::int AS n FROM "MoveRawResponse" WHERE "match_id" = 'old' AND "move_index" = 0` } },
  { key: 'cascade-match', step: { sql: `DELETE FROM "Match" WHERE "id" = 'old'` } },
  { key: 'after-match-delete', step: { sql: `SELECT count(*)::int AS n FROM "MoveRawResponse"` } }
];

describe('migration: MoveRawResponse', () => {
  let out: Record<string, { ok: boolean; rows?: any[]; error?: string }>;
  beforeAll(() => {
    const setup = [match('old'), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => mv('old', i)).filter((_, i) => i !== 9)];
    const run = spawnSync(process.execPath, ['scripts/pglite-replay.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 500_000, input: JSON.stringify({ target: NEW, setup, checks: checks.map(c => c.step) })
    });
    if (run.status !== 0) throw new Error(`replay failed: ${String(run.stderr).slice(-600)}`);
    out = Object.fromEntries(checks.map((c, i) => [c.key, JSON.parse(run.stdout).results[i]]));
  }, 600_000);

  it('applies on top of existing moves', () => expect(out.legacy.rows).toEqual([{ n: 9 }]));
  it('stores a response and reads it back', () => {
    expect(out.valid.ok).toBe(true);
    expect(out.read.rows).toEqual([{ body: '{"a":1}', bytes: 7, truncated: false, has_time: true }]);
  });
  it('allows one raw response per move', () => expect(out.duplicate.error).toContain('MoveRawResponse_pkey'));
  it('needs an existing move', () => expect(out['no-move'].error).toContain('MoveRawResponse_match_id_move_index_fkey'));

  describe('the size limit is enforced by the database itself', () => {
    it('64 KiB is allowed', () => expect(out['at-limit'].ok).toBe(true));
    it('one byte more is refused', () => expect(out['over-limit'].error).toContain('MoveRawResponse_size_limit_chk'));
  });

  describe('the other constraints', () => {
    it('the digest must be 64 lowercase hex characters', () => expect(out['bad-sha'].error).toContain('MoveRawResponse_sha256_format_chk'));
    it('the size cannot be negative', () => expect(out['negative-bytes'].error).toContain('MoveRawResponse_bytes_chk'));
    it('an untruncated copy must be exactly the whole response', () => expect(out['untruncated-wrong-size'].error).toContain('MoveRawResponse_truncation_chk'));
    it('a truncated copy must be shorter than the whole', () => {
      expect(out['truncated-valid'].ok).toBe(true);
      expect(out['truncated-longer-than-whole'].error).toContain('MoveRawResponse_truncation_chk');
    });
    it('sizes are in bytes, not characters', () => expect(out['multibyte-counts-bytes'].ok).toBe(true));
  });

  it('has an index on created_at for retention', () => expect(out.index.rows![0].indexdef).toMatch(/\(created_at\)/));

  it('is deleted with its move, and with its match', () => {
    expect(out['cascade-move'].ok).toBe(true);
    expect(out['after-move-delete'].rows).toEqual([{ n: 0 }]);
    expect(out['cascade-match'].ok).toBe(true);
    expect(out['after-match-delete'].rows).toEqual([{ n: 0 }]);
  });
});
