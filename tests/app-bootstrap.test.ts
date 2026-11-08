import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');

describe('serverless bootstrap', () => {
  it('seeds the built-in games once per cold start on Vercel, never blocking or crashing the site', () => {
    expect(source).toContain("process.env.VERCEL && isDatabaseConfigured()");
    expect(source).toContain('ensureDefaultGamesOnce().catch');
    // it must not be awaited in the request path
    expect(source).not.toMatch(/await ensureDefaultGamesOnce/);
  });

  it('is guarded so local development and tests (no VERCEL env) never touch the database at startup', () => {
    const guard = source.indexOf('process.env.VERCEL && isDatabaseConfigured()');
    const call = source.indexOf('ensureDefaultGamesOnce().catch');
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
  });
});
