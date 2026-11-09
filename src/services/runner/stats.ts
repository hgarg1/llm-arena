import { prisma } from '../../config/db';
import { getEnv, getRunnerMode } from '../../config/runtime';
import { limitsFor } from '../rate-limit.service';

export interface ProviderStat {
  provider: string;
  calls: number;
  p50Ms: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
  rpm: number | null;
  tpm: number | null;
}

export interface RunnerStats {
  mode: string;
  cap: number;
  pending: number;
  oldestPendingMinutes: number | null;
  runningLeased: number;
  runningOrphaned: number;
  completed24h: number;
  failed24h: number;
  cancelled24h: number;
  budgetFailures24h: number;
  throttleWaits24h: number;
  avgSlicesCompleted24h: number | null;
  providers: ProviderStat[];
  longestRunning: Array<{ id: string; game_type: string; minutes: number; slices: number; moves: number }>;
}

const n = (value: unknown) => Number(value ?? 0);

/** Everything the runner health page shows, from the tables the runner already writes. */
export const getRunnerStats = async (now = new Date()): Promise<RunnerStats> => {
  const day = new Date(now.getTime() - 24 * 3_600_000);
  const hour = new Date(now.getTime() - 3_600_000);

  const [pending, oldest, leased, orphaned, completed, failed, cancelled, budget, throttle, slices, providers, longest] = await Promise.all([
    prisma.match.count({ where: { status: 'PENDING' } }),
    prisma.match.findFirst({ where: { status: 'PENDING' }, orderBy: { created_at: 'asc' }, select: { created_at: true } }),
    prisma.match.count({ where: { status: 'RUNNING', lease_expires_at: { gt: now } } }),
    prisma.match.count({ where: { status: 'RUNNING', OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }] } }),
    prisma.match.count({ where: { status: 'COMPLETED', finished_at: { gte: day } } }),
    prisma.match.count({ where: { status: 'FAILED', finished_at: { gte: day } } }),
    prisma.match.count({ where: { status: 'CANCELLED', finished_at: { gte: day } } }),
    prisma.match.count({ where: { status: 'FAILED', finished_at: { gte: day }, failure_reason: { startsWith: 'Exceeded' } } }),
    prisma.match.aggregate({ _sum: { rate_limit_waits: true }, where: { created_at: { gte: day } } }),
    prisma.match.aggregate({ _avg: { slice_count: true }, where: { status: 'COMPLETED', finished_at: { gte: day }, slice_count: { gt: 0 } } }),
    prisma.$queryRaw<Array<{ provider: string; calls: number; p50: number; p95: number; input_tokens: number; output_tokens: number }>>`
      SELECT provider,
             COUNT(*)::int AS calls,
             COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p50,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::float8 AS p95,
             COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
      FROM "MatchMove"
      WHERE provider IS NOT NULL AND created_at >= ${hour}
      GROUP BY provider
      ORDER BY calls DESC`,
    prisma.match.findMany({
      where: { status: 'RUNNING' },
      orderBy: { started_at: 'asc' },
      take: 5,
      select: { id: true, game_type: true, started_at: true, created_at: true, slice_count: true, _count: { select: { moves: true } } }
    })
  ]);

  return {
    mode: getRunnerMode(),
    cap: Number(getEnv('MATCH_RUNNER_CONCURRENCY')) || 50,
    pending,
    oldestPendingMinutes: oldest ? Math.round((now.getTime() - oldest.created_at.getTime()) / 60_000) : null,
    runningLeased: leased,
    runningOrphaned: orphaned,
    completed24h: completed,
    failed24h: failed,
    cancelled24h: cancelled,
    budgetFailures24h: budget,
    throttleWaits24h: n(throttle._sum.rate_limit_waits),
    avgSlicesCompleted24h: slices._avg.slice_count === null ? null : Math.round(n(slices._avg.slice_count) * 10) / 10,
    providers: providers.map(row => {
      const limits = limitsFor(row.provider);
      return {
        provider: row.provider,
        calls: n(row.calls),
        p50Ms: Math.round(n(row.p50)),
        p95Ms: Math.round(n(row.p95)),
        inputTokens: n(row.input_tokens),
        outputTokens: n(row.output_tokens),
        rpm: limits.rpm,
        tpm: limits.tpm
      };
    }),
    longestRunning: longest.map(m => ({
      id: m.id,
      game_type: m.game_type,
      minutes: Math.round((now.getTime() - (m.started_at ?? m.created_at).getTime()) / 60_000),
      slices: m.slice_count,
      moves: m._count.moves
    }))
  };
};
