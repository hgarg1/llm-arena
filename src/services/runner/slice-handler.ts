import { prisma } from '../../config/db';
import { getEnv } from '../../config/runtime';
import { runMatchSlice } from '../match-runner.service';
import { buildRunnerDeps } from './default-deps';
import { dispatchSlice } from './dispatch';

const MATCH_ID = /^[0-9a-f-]{36}$/i;
/** Time kept back for cold start, lease handling, replay and the final commit. */
const SLICE_MARGIN_MS = 15_000;

export interface SliceRequest {
  matchId: unknown;
  continuation?: unknown;
}

type WaitUntil = (promise: Promise<unknown>) => void;

/** `waitUntil` keeps a Vercel function alive after it has responded; outside Vercel it is a no-op. */
export const resolveWaitUntil = (): WaitUntil => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@vercel/functions');
    if (typeof mod.waitUntil === 'function') return mod.waitUntil;
  } catch {
    // not running on Vercel
  }
  return promise => { void promise; };
};

export const sliceBudgetMs = () => (Number(getEnv('MATCH_SLICE_MAX_DURATION_S')) || 300) * 1000;

/** Runs one slice, then chains the next one if the match yielded. Never throws. */
export const performSlice = async (matchId: string, startedAt = Date.now()): Promise<void> => {
  try {
    const deps = await buildRunnerDeps();
    const window = sliceBudgetMs() - SLICE_MARGIN_MS;
    // A model call must fit in the slice, or the match could never make progress.
    deps.moveTimeoutMs = Math.min(deps.moveTimeoutMs ?? 60_000, Math.floor(window / 2));
    const result = await runMatchSlice(matchId, undefined, deps, { deadlineAt: startedAt + window });
    if (result.status === 'yielded') await dispatchSlice(matchId, { continuation: true });
  } catch (err: any) {
    // runMatchSlice has already marked the match FAILED; nothing to chain.
    console.error(`Slice for match ${matchId} failed: ${err?.message || err}`);
  }
};

/**
 * Validates the request, applies admission control to brand-new matches, answers 202 immediately and
 * does the work in the background.
 */
export const acceptSlice = async (
  body: SliceRequest,
  waitUntil: WaitUntil = resolveWaitUntil()
): Promise<{ status: number; body: Record<string, unknown> }> => {
  if (typeof body?.matchId !== 'string' || !MATCH_ID.test(body.matchId)) {
    return { status: 400, body: { error: 'matchId must be a match id' } };
  }
  const matchId = body.matchId;

  if (!body.continuation) {
    const cap = Number(getEnv('MATCH_RUNNER_CONCURRENCY')) || 50;
    const active = await prisma.match.count({ where: { status: 'RUNNING', lease_expires_at: { gt: new Date() } } });
    if (active >= cap) {
      // Stays PENDING; the sweeper starts it as soon as capacity frees up.
      return { status: 202, body: { accepted: false, deferred: true, active, cap } };
    }
  }

  waitUntil(performSlice(matchId));
  return { status: 202, body: { accepted: true } };
};
