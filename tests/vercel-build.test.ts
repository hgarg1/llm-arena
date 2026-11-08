import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'vercel-build.mjs');

const runScript = (env: Record<string, string | undefined>) => {
  const merged = { ...process.env, VERCEL_ENV: undefined, DATABASE_URL: undefined, DIRECT_URL: undefined, MIGRATE_DATABASE_URL: undefined, ...env } as NodeJS.ProcessEnv;
  Object.keys(merged).forEach(k => merged[k] === undefined && delete merged[k]);
  return spawnSync('node', [script], { env: merged, encoding: 'utf8', timeout: 60_000 });
};

describe('vercel-build', () => {
  it('is wired as the project build command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['vercel-build']).toBe('node scripts/vercel-build.mjs');
    expect(pkg.scripts.build).toBe('tsc && npm run build:css'); // unchanged: previews still just build
  });

  it('does not migrate by default, so an unreachable database can never block a deploy (and says so loudly)', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain('NOT applying migrations');
    expect(source).toContain('VERCEL_MIGRATE_ON_BUILD');
    expect(source.indexOf('migrateOnBuild')).toBeLessThan(source.indexOf("Applying pending Prisma migrations"));
  });

  it('when opted in, refuses a production build that has no database to migrate (never ships unmigrated code)', () => {
    const result = runScript({ VERCEL_ENV: 'production', VERCEL_MIGRATE_ON_BUILD: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to deploy without applying migrations');
  });

  it('fails the build, and says so, when migrations cannot be applied', () => {
    const result = runScript({ VERCEL_ENV: 'production', VERCEL_MIGRATE_ON_BUILD: 'true', DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=2' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Applying pending Prisma migrations');
    expect(result.stderr).toMatch(/migrate deploy failed/);
  }, 90_000);

  it('previews skip migrations entirely (they have no database)', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source).toContain("process.env.VERCEL_ENV === 'production'");
    expect(source).toContain('Skipping migrations');
  });

  it('prefers a direct connection for migrations when one is provided', () => {
    const source = fs.readFileSync(script, 'utf8');
    expect(source.indexOf('MIGRATE_DATABASE_URL')).toBeLessThan(source.indexOf('DIRECT_URL'));
    expect(source.indexOf('DIRECT_URL')).toBeLessThan(source.indexOf('process.env.DATABASE_URL;'));
  });
});
