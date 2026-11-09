import { withPoolerParams } from '../src/config/db';

describe('withPoolerParams', () => {
  const neonPooled = 'postgresql://user:pw@ep-cool-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require';
  const neonDirect = 'postgresql://user:pw@ep-cool-123.us-east-1.aws.neon.tech/neondb?sslmode=require';

  it('makes a Neon pooled URL safe for Prisma: pgbouncer mode and one connection per serverless instance', () => {
    const url = new URL(withPoolerParams(neonPooled, true)!);
    expect(url.searchParams.get('pgbouncer')).toBe('true');
    expect(url.searchParams.get('connection_limit')).toBe('1');
    expect(url.searchParams.get('sslmode')).toBe('require'); // existing parameters survive
  });

  it('does not force a single connection outside serverless (workers, local development)', () => {
    const url = new URL(withPoolerParams(neonPooled, false)!);
    expect(url.searchParams.get('pgbouncer')).toBe('true');
    expect(url.searchParams.has('connection_limit')).toBe(false);
  });

  it('leaves a direct (unpooled) URL completely alone', () => {
    expect(withPoolerParams(neonDirect, true)).toBe(neonDirect);
    expect(withPoolerParams('postgresql://u:p@db.internal:5432/app', true)).toBe('postgresql://u:p@db.internal:5432/app');
  });

  it('respects values the operator already set', () => {
    const custom = 'postgresql://u:p@x-pooler.neon.tech/db?pgbouncer=true&connection_limit=5';
    const url = new URL(withPoolerParams(custom, true)!);
    expect(url.searchParams.get('connection_limit')).toBe('5');
  });

  it('treats an explicit pgbouncer=true on any host as pooled', () => {
    const url = new URL(withPoolerParams('postgresql://u:p@pooler.supabase.com:6543/postgres?pgbouncer=true', true)!);
    expect(url.searchParams.get('connection_limit')).toBe('1');
  });

  it('passes through missing or unparseable values without throwing', () => {
    expect(withPoolerParams(undefined)).toBeUndefined();
    expect(withPoolerParams('')).toBe('');
    expect(withPoolerParams('not a url')).toBe('not a url');
  });

  it('keeps special characters in the password intact', () => {
    const tricky = 'postgresql://user:p%40ss%2Fw0rd%3F@ep-1-pooler.neon.tech/db';
    expect(withPoolerParams(tricky, true)).toContain('p%40ss%2Fw0rd%3F');
  });
});
