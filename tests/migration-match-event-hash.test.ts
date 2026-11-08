/**
 * The hash-chain migration (docs/INTEGRITY_SPEC.md) replayed on a real Postgres (PGlite, in process, no external database):
 * every earlier migration is applied, legacy events are stored, then the new migration runs on top of them.
 * PGlite runs in a child process (scripts/pglite-replay.mjs) because jest cannot import it directly.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const NEW = '20260412090000_match_event_hash_chain';
const HASH_A = 'a'.repeat(64);
const HASH_B = '0123456789abcdef'.repeat(4);

type Step = { sql: string; params?: unknown[] };
const matchSql: Step = { sql: `INSERT INTO "Match" ("id", "game_type", "seed") VALUES ($1, 'chess', 42)` };
const match = (id: string): Step => ({ ...matchSql, params: [id] });
const event = (matchId: string, seq: number, hash: string | null = null, prev: string | null = null): Step => ({
  sql: `INSERT INTO "MatchEvent" ("id", "match_id", "turn_index", "seq", "actor_role", "type", "payload", "hash", "prev_hash")
        VALUES (gen_random_uuid()::text, $1, $2, $2, 'system', 'STEP', '{"n":1}'::jsonb, $3, $4)`,
  params: [matchId, seq, hash, prev]
});

// the shape events had before this migration existed (no hash columns)
const legacyEvent = (matchId: string, seq: number): Step => ({
  sql: `INSERT INTO "MatchEvent" ("id", "match_id", "turn_index", "seq", "actor_role", "type", "payload")
        VALUES (gen_random_uuid()::text, $1, $2, $2, 'system', 'STEP', '{"n":1}'::jsonb)`,
  params: [matchId, seq]
});

const BAD: [string, string | null, string | null][] = [
  ['uppercase hex', 'A'.repeat(64), HASH_A],
  ['63 characters', 'a'.repeat(63), HASH_A],
  ['non-hex characters', 'g'.repeat(64), HASH_A],
  ['empty string', '', HASH_A],
  ['0x prefix', '0x' + 'a'.repeat(62), HASH_A],
  ['prev_hash uppercase', HASH_A, 'Z'.repeat(64)],
  ['65 characters (column width)', 'a'.repeat(65), HASH_A],
  ['hash without prev_hash', HASH_A, null],
  ['prev_hash without hash', null, HASH_A]
];

const checks: { key: string; step: Step }[] = [
  { key: 'legacy', step: { sql: `SELECT "seq", "type", "actor_role", "payload", "hash", "prev_hash" FROM "MatchEvent" WHERE "match_id" = 'legacy' ORDER BY "seq"` } },
  { key: 'columns', step: { sql: `SELECT column_name, is_nullable, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'MatchEvent' AND column_name IN ('hash', 'prev_hash') ORDER BY column_name` } },
  { key: 'm-unchained', step: match('unchained') },
  { key: 'e-unchained', step: event('unchained', 0) },
  { key: 'r-unchained', step: { sql: `SELECT "hash", "prev_hash" FROM "MatchEvent" WHERE "match_id" = 'unchained'` } },
  { key: 'm-chained', step: match('chained') },
  { key: 'e-chained', step: event('chained', 0, HASH_A, HASH_B) },
  { key: 'r-chained', step: { sql: `SELECT "hash", "prev_hash" FROM "MatchEvent" WHERE "match_id" = 'chained'` } },
  { key: 'u-legacy', step: { sql: `UPDATE "MatchEvent" SET "hash" = $1, "prev_hash" = $2 WHERE "match_id" = 'legacy' AND "seq" = 0`, params: [HASH_B, HASH_A] } },
  { key: 'r-legacy', step: { sql: `SELECT "hash", "prev_hash" FROM "MatchEvent" WHERE "match_id" = 'legacy' AND "seq" = 0` } },
  { key: 'm-bad', step: match('bad') },
  ...BAD.map(([label, hash, prev]) => ({ key: `bad:${label}`, step: event('bad', 0, hash, prev) })),
  { key: 'bad-count', step: { sql: `SELECT count(*)::int AS n FROM "MatchEvent" WHERE "match_id" = 'bad'` } }
];

describe('migration: MatchEvent hash chain columns', () => {
  let out: Record<string, { ok: boolean; rows?: any[]; error?: string }>;
  let migrations: string[];

  beforeAll(() => {
    migrations = fs.readdirSync(path.join(root, 'prisma', 'migrations')).filter(n => fs.statSync(path.join(root, 'prisma', 'migrations', n)).isDirectory()).sort();
    const run = spawnSync(process.execPath, ['scripts/pglite-replay.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ target: NEW, setup: [match('legacy'), legacyEvent('legacy', 0), legacyEvent('legacy', 1)], checks: checks.map(c => c.step) })
    });
    if (run.status !== 0) throw new Error(`replay failed: ${String(run.stderr).slice(-600)}`);
    const { results } = JSON.parse(run.stdout);
    out = Object.fromEntries(checks.map((c, i) => [c.key, results[i]]));
  }, 150_000);

  it('is the newest migration, so this replay is the order production applies', () => {
    expect(migrations[migrations.length - 1]).toBe(NEW);
  });

  it('applies cleanly on top of existing data and leaves existing events readable', () => {
    const rows = out.legacy.rows!;
    expect(out.legacy.ok).toBe(true);
    expect(rows.map(r => r.seq)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ type: 'STEP', actor_role: 'system', payload: { n: 1 }, hash: null, prev_hash: null });
  });

  it('adds two nullable VARCHAR(64) columns', () => {
    expect(out.columns.rows).toEqual([
      { column_name: 'hash', is_nullable: 'YES', data_type: 'character varying', character_maximum_length: 64 },
      { column_name: 'prev_hash', is_nullable: 'YES', data_type: 'character varying', character_maximum_length: 64 }
    ]);
  });

  it('still accepts events without hashes (the runner is unchanged until m1-03)', () => {
    expect(out['e-unchained'].ok).toBe(true);
    expect(out['r-unchained'].rows).toEqual([{ hash: null, prev_hash: null }]);
  });

  it('stores a valid hash pair on new events and on updated legacy events', () => {
    expect(out['e-chained'].ok).toBe(true);
    expect(out['r-chained'].rows).toEqual([{ hash: HASH_A, prev_hash: HASH_B }]);
    expect(out['u-legacy'].ok).toBe(true);
    expect(out['r-legacy'].rows).toEqual([{ hash: HASH_B, prev_hash: HASH_A }]);
  });

  describe('rejects malformed hashes', () => {
    it.each(BAD.map(([label]) => label))('%s', label => {
      const result = out[`bad:${label}`];
      expect(result.ok).toBe(false);
    });
    it('names the constraint that fired', () => {
      expect(out['bad:uppercase hex'].error).toContain('MatchEvent_hash_format_chk');
      expect(out['bad:prev_hash uppercase'].error).toContain('MatchEvent_prev_hash_format_chk');
      expect(out['bad:hash without prev_hash'].error).toContain('MatchEvent_hash_pair_chk');
      expect(out['bad:prev_hash without hash'].error).toContain('MatchEvent_hash_pair_chk');
    });
    it('leaves no partial rows behind', () => {
      expect(out['bad-count'].rows).toEqual([{ n: 0 }]);
    });
  });

  it('is declared in schema.prisma with the same names and width', () => {
    const schema = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8');
    const model = /model MatchEvent \{[\s\S]*?\n\}/.exec(schema)![0];
    expect(model).toMatch(/\bhash\s+String\?\s+@db\.VarChar\(64\)/);
    expect(model).toMatch(/\bprev_hash\s+String\?\s+@db\.VarChar\(64\)/);
  });
});
