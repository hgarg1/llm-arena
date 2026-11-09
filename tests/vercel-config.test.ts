import fs from 'fs';
import path from 'path';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const root = path.join(__dirname, '..');

describe('vercel.json', () => {
  it('uses the current functions/rewrites model, not the legacy builds/routes (functions cannot be combined with builds)', () => {
    expect(config.builds).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.functions).toBeDefined();
    expect(config.rewrites).toBeDefined();
  });

  it('gives the match function its own, longer duration than the website', () => {
    expect(config.functions['api/internal.js'].maxDuration).toBe(300);
    expect(config.functions['api/index.js'].maxDuration).toBeUndefined();
    // the slice budget the runner assumes must not exceed what the platform will allow
    const budget = Number(process.env.MATCH_SLICE_MAX_DURATION_S) || 300;
    expect(budget).toBeLessThanOrEqual(config.functions['api/internal.js'].maxDuration);
  });

  it('routes the internal API to its own function before the catch-all', () => {
    const sources = config.rewrites.map((r: any) => r.source);
    expect(sources.indexOf('/api/internal/:path*')).toBeGreaterThanOrEqual(0);
    expect(sources.indexOf('/api/internal/:path*')).toBeLessThan(sources.indexOf('/(.*)'));
    const internal = config.rewrites.find((r: any) => r.source === '/api/internal/:path*');
    expect(internal.destination).toBe('/api/internal');
    expect(config.rewrites.find((r: any) => r.source === '/(.*)').destination).toBe('/api/index');
  });

  it('both function entry files exist and are what the config names', () => {
    for (const file of Object.keys(config.functions)) expect(fs.existsSync(path.join(root, file))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'api/internal.js'), 'utf8')).toContain("require('../dist/runner-app')");
    expect(fs.readFileSync(path.join(root, 'api/index.js'), 'utf8')).toContain("require('../dist/app')");
  });

  it('each function bundles what it needs at runtime (views for the site, prisma client for both)', () => {
    expect(config.functions['api/index.js'].includeFiles).toContain('views');
    for (const fn of Object.values<any>(config.functions)) {
      expect(fn.includeFiles).toContain('dist');
      expect(fn.includeFiles).toContain('node_modules/.prisma');
    }
  });

  it('the cron hits a real internal route with a path Vercel will not redirect', () => {
    expect(config.crons).toHaveLength(1);
    const cron = config.crons[0];
    expect(cron.path).toBe('/api/internal/sweep');
    expect(cron.path.endsWith('/')).toBe(false); // crons do not follow redirects
    expect(cron.schedule).toBe('* * * * *');     // per-minute needs Pro
    const source = fs.readFileSync(path.join(root, 'src/runner-app.ts'), 'utf8');
    expect(source).toContain("'/api/internal/sweep'");
    expect(source).toContain("'/api/internal/match-slice'");
  });

  it('the compiled entry points are produced by the TypeScript build', () => {
    expect(fs.existsSync(path.join(root, 'src/runner-app.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/app.ts'))).toBe(true);
  });
});
