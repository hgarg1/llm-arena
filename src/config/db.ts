import { PrismaClient } from '@prisma/client';

// Prevent multiple instances of Prisma Client in development
declare global {
  // eslint-disable-next-line no-var -- `declare global` requires var
  var prisma: PrismaClient | undefined;
}

/**
 * Connection poolers (Neon's `-pooler` hosts, PgBouncer) run in transaction mode, which Prisma only works with when
 * prepared statements are disabled (`pgbouncer=true`). On serverless every function instance should also hold a single
 * connection (`connection_limit=1`). Both are added here when they are not already part of the URL, so the same
 * `DATABASE_URL` the database integration provides works unchanged.
 */
export const withPoolerParams = (url: string | undefined, serverless = Boolean(process.env.VERCEL)): string | undefined => {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pooled = /-pooler\./.test(parsed.hostname) || parsed.searchParams.get('pgbouncer') === 'true';
  if (pooled && !parsed.searchParams.has('pgbouncer')) parsed.searchParams.set('pgbouncer', 'true');
  if (pooled && serverless && !parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
};

const url = withPoolerParams(process.env.DATABASE_URL);

export const prisma = global.prisma || new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
