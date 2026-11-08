/** The MatchManifest table, replayed on PGlite on top of existing data (see scripts/pglite-replay.mjs). */
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.join(__dirname, '..');
const NEW = '20260414090000_match_manifest';
type Step = { sql: string; params?: unknown[] };
const match = (id: string): Step => ({ sql: `INSERT INTO "Match" ("id", "game_type", "seed") VALUES ($1, 'chess', 42)`, params: [id] });
const manifest = (id: string, keyId = 'abcdabcdabcdabcd'): Step => ({
  sql: `INSERT INTO "MatchManifest" ("match_id", "key_id", "manifest", "signature") VALUES ($1, $2, '{"spec":"arena-integrity/1"}'::jsonb, 'c2ln')`,
  params: [id, keyId]
});

const checks: { key: string; step: Step }[] = [
  { key: 'existing', step: { sql: `SELECT count(*)::int AS n FROM "Match" WHERE "id" = 'old'` } },
  { key: 'insert', step: manifest('old') },
  { key: 'read', step: { sql: `SELECT "key_id", "manifest", "signature", "signed_at" IS NOT NULL AS has_time FROM "MatchManifest" WHERE "match_id" = 'old'` } },
  { key: 'duplicate', step: manifest('old') },
  { key: 'no-match', step: manifest('missing') },
  { key: 'long-key-id', step: manifest('old', 'x'.repeat(17)) },
  { key: 'delete-match', step: { sql: `DELETE FROM "Match" WHERE "id" = 'old'` } },
  { key: 'cascade', step: { sql: `SELECT count(*)::int AS n FROM "MatchManifest"` } }
];

describe('migration: MatchManifest', () => {
  let out: Record<string, { ok: boolean; rows?: any[]; error?: string }>;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['scripts/pglite-replay.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 120_000, input: JSON.stringify({ target: NEW, setup: [match('old')], checks: checks.map(c => c.step) })
    });
    if (run.status !== 0) throw new Error(`replay failed: ${String(run.stderr).slice(-600)}`);
    out = Object.fromEntries(checks.map((c, i) => [c.key, JSON.parse(run.stdout).results[i]]));
  }, 150_000);

  it('applies on top of existing matches', () => expect(out.existing.rows).toEqual([{ n: 1 }]));
  it('stores and returns a manifest', () => {
    expect(out.insert.ok).toBe(true);
    expect(out.read.rows).toEqual([{ key_id: 'abcdabcdabcdabcd', manifest: { spec: 'arena-integrity/1' }, signature: 'c2ln', has_time: true }]);
  });
  it('allows one manifest per match', () => {
    expect(out.duplicate.ok).toBe(false);
    expect(out.duplicate.error).toContain('MatchManifest_pkey');
  });
  it('needs an existing match, and a key id of at most 16 characters', () => {
    expect(out['no-match'].error).toContain('MatchManifest_match_id_fkey');
    expect(out['long-key-id'].ok).toBe(false);
  });
  it('is deleted with its match', () => {
    expect(out['delete-match'].ok).toBe(true);
    expect(out.cascade.rows).toEqual([{ n: 0 }]);
  });
});
