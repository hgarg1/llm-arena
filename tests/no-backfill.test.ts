/**
 * Story m1-09: "no backfilled signatures are created for old matches". A manifest vouches that a log was witnessed and
 * sealed when the match ended; signing an old match later would vouch for a record nobody witnessed. These checks make
 * sure no code path, script, seed or migration can do it.
 */
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const walk = (dir: string, exts: string[]): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return fs.statSync(p).isDirectory() ? walk(p, exts) : exts.some(e => p.endsWith(e)) ? [p] : [];
  }) : [];
const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');

describe('nothing writes a manifest except the sealing service', () => {
  const code = [...walk(path.join(root, 'src'), ['.ts']), ...walk(path.join(root, 'scripts'), ['.mjs', '.js', '.ts']), ...walk(path.join(root, 'prisma'), ['.ts', '.js'])];

  it('the only code that creates, updates or upserts a MatchManifest is src/services/match-manifest.service.ts', () => {
    const writers = code.filter(file => /matchManifest\s*\.\s*(create|createMany|upsert|update|updateMany)\b/.test(fs.readFileSync(file, 'utf8')));
    expect(writers.map(rel)).toEqual(['src/services/match-manifest.service.ts']);
  });

  it('and inside it, there is exactly one place that creates one', () => {
    const source = fs.readFileSync(path.join(root, 'src/services/match-manifest.service.ts'), 'utf8');
    expect(source.match(/matchManifest\.create\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/matchManifest\.(createMany|upsert|update|updateMany)/);
  });

  it('no migration, seed or script inserts manifest rows with SQL', () => {
    const sql = [...walk(path.join(root, 'prisma'), ['.sql', '.ts', '.js']), ...walk(path.join(root, 'scripts'), ['.mjs', '.js', '.ts', '.sql'])];
    for (const file of sql) {
      const text = fs.readFileSync(file, 'utf8');
      expect({ file: rel(file), writes: /INSERT\s+INTO\s+"?MatchManifest"?|UPDATE\s+"?MatchManifest"?/i.test(text) }).toEqual({ file: rel(file), writes: false });
    }
  });

  it('the repair pass is the only caller that scans for matches to sign, and it is gated by the start of the chain era', () => {
    const source = fs.readFileSync(path.join(root, 'src/services/match-manifest.service.ts'), 'utf8');
    expect(source).toMatch(/firstChained/);
    expect(source).toMatch(/Never backfill/);
    const callers = code.filter(f => /sealUnsealed\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    expect(callers).toEqual(['src/services/runner/sweeper.ts']);
  });

  it('the spec states the rule', () => {
    const spec = fs.readFileSync(path.join(root, 'docs/INTEGRITY_SPEC.md'), 'utf8');
    expect(spec).toMatch(/MUST NOT backfill signatures/);
  });
});
