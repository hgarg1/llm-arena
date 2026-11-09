/** The MatchMove.provenance column, replayed on PGlite on top of existing moves (see scripts/pglite-replay.mjs). */
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.join(__dirname, '..');
const NEW = '20260415090000_match_move_provenance';
type Step = { sql: string; params?: unknown[] };
const match = (id: string): Step => ({ sql: `INSERT INTO "Match" ("id", "game_type", "seed") VALUES ($1, 'chess', 42)`, params: [id] });
const legacyMove = (matchId: string, index: number): Step => ({
  sql: `INSERT INTO "MatchMove" ("id", "match_id", "move_index", "actor_role", "content") VALUES (gen_random_uuid()::text, $1, $2, 'white', 'e2e4')`, params: [matchId, index]
});
const move = (matchId: string, index: number, provenance: string | null): Step => ({
  sql: `INSERT INTO "MatchMove" ("id", "match_id", "move_index", "actor_role", "content", "provenance") VALUES (gen_random_uuid()::text, $1, $2, 'white', 'e2e4', $3::jsonb)`, params: [matchId, index, provenance]
});

const checks: { key: string; step: Step }[] = [
  { key: 'legacy', step: { sql: `SELECT "move_index", "content", "provenance" FROM "MatchMove" WHERE "match_id" = 'old' ORDER BY "move_index"` } },
  { key: 'column', step: { sql: `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'MatchMove' AND column_name = 'provenance'` } },
  { key: 'object', step: move('old', 2, '{"v":1,"source":"model","model":{"reported":"unknown"}}') },
  { key: 'read', step: { sql: `SELECT "provenance" FROM "MatchMove" WHERE "match_id" = 'old' AND "move_index" = 2` } },
  { key: 'null', step: move('old', 3, null) },
  { key: 'array', step: move('old', 4, '[1,2]') },
  { key: 'string', step: move('old', 5, '"text"') },
  { key: 'number', step: move('old', 6, '7') },
  { key: 'json-null', step: move('old', 7, 'null') },
  { key: 'count', step: { sql: `SELECT count(*)::int AS n FROM "MatchMove" WHERE "match_id" = 'old'` } }
];

describe('migration: MatchMove provenance', () => {
  let out: Record<string, { ok: boolean; rows?: any[]; error?: string }>;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['scripts/pglite-replay.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 500_000, input: JSON.stringify({ target: NEW, setup: [match('old'), legacyMove('old', 0), legacyMove('old', 1)], checks: checks.map(c => c.step) })
    });
    if (run.status !== 0) throw new Error(`replay failed: ${String(run.stderr).slice(-600)}`);
    out = Object.fromEntries(checks.map((c, i) => [c.key, JSON.parse(run.stdout).results[i]]));
  }, 600_000);

  it('applies on top of existing moves, which stay readable and read back as "not recorded" (NULL)', () => {
    expect(out.legacy.rows).toEqual([{ move_index: 0, content: 'e2e4', provenance: null }, { move_index: 1, content: 'e2e4', provenance: null }]);
  });
  it('adds a nullable JSONB column', () => expect(out.column.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]));
  it('stores a provenance object and reads it back unchanged', () => {
    expect(out.object.ok).toBe(true);
    expect(out.read.rows).toEqual([{ provenance: { v: 1, source: 'model', model: { reported: 'unknown' } } }]);
  });
  it('accepts NULL', () => expect(out.null.ok).toBe(true));
  it.each(['array', 'string', 'number', 'json-null'])('rejects a %s (provenance is an object or NULL)', key => {
    expect(out[key].ok).toBe(false);
    expect(out[key].error).toContain('MatchMove_provenance_object_chk');
  });
  it('wrote only the valid rows', () => expect(out.count.rows).toEqual([{ n: 4 }]));
});
