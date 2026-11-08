import { prisma } from '../../config/db';
import { getEnv } from '../../config/runtime';
import { dispatchSlice } from './dispatch';

const intEnv = (name: string, fallback: number) => {
  const value = Number(getEnv(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export interface SweepResult {
  resumed: number;
  started: number;
  expired: number;
  active: number;
  cap: number;
}

/**
 * Runs every minute (Vercel Cron). It is the safety net behind slice chaining and also the admission
 * controller:
 *  - resumes RUNNING matches whose runner died (lease expired or never taken);
 *  - starts PENDING matches while fewer than MATCH_RUNNER_CONCURRENCY matches are active;
 *  - fails PENDING matches older than MATCH_PENDING_MAX_AGE_HOURS so an old backlog can never start by surprise.
 */
export const sweepMatches = async (now = new Date(), dispatch = dispatchSlice): Promise<SweepResult> => {
  const cap = intEnv('MATCH_RUNNER_CONCURRENCY', 50);
  const maxAgeMs = intEnv('MATCH_PENDING_MAX_AGE_HOURS', 24) * 3_600_000;
  const settleMs = 15_000; // let the creating request's own dispatch go first

  const expired = await prisma.match.updateMany({
    where: { status: 'PENDING', created_at: { lt: new Date(now.getTime() - maxAgeMs) } },
    data: { status: 'FAILED', finished_at: now, failure_reason: 'Expired before a runner picked it up. Retry it from the admin match list.' }
  });

  const leaseFree = [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }];
  const active = await prisma.match.count({ where: { status: 'RUNNING', lease_expires_at: { gt: now } } });

  const resumable = await prisma.match.findMany({
    where: { status: 'RUNNING', OR: leaseFree },
    orderBy: { created_at: 'asc' },
    take: 50,
    select: { id: true }
  });

  const room = Math.max(0, cap - active - resumable.length);
  const pending = room === 0 ? [] : await prisma.match.findMany({
    where: { status: 'PENDING', created_at: { lt: new Date(now.getTime() - settleMs) }, OR: leaseFree },
    orderBy: { created_at: 'asc' },
    take: Math.min(room, 50),
    select: { id: true }
  });

  await Promise.allSettled([
    ...resumable.map(m => dispatch(m.id, { continuation: true })),
    ...pending.map(m => dispatch(m.id, { continuation: false }))
  ]);

  return { resumed: resumable.length, started: pending.length, expired: expired.count, active, cap };
};
