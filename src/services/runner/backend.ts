import { getRunnerMode } from '../../config/runtime';
import { matchQueue } from '../queue';
import { settingsService } from '../settings.service';
import { runMatch } from '../match-runner.service';
import { buildRunnerDeps } from './default-deps';
import { dispatchSlice } from './dispatch';

/**
 * Hands a newly created (or retried) match to whichever runner this deployment uses.
 * Throws only for modes where a failure to hand off means the match would never run (BullMQ);
 * on Vercel a lost dispatch is repaired by the sweeper, so it is logged instead.
 */
export const startMatch = async (matchId: string, options?: unknown) => {
  const mode = getRunnerMode();
  if (mode === 'vercel') {
    await dispatchSlice(matchId, { continuation: false });
    return;
  }
  if (mode === 'bullmq') {
    const settings = await settingsService.getAll();
    const attempts = parseInt(settings.queue_retry_attempts || '3', 10);
    const backoffMs = parseInt(settings.queue_retry_backoff_ms || '5000', 10);
    await matchQueue.add(
      'run-match',
      { matchId, options },
      { attempts: Math.max(1, attempts), backoff: { type: 'fixed', delay: Math.max(0, backoffMs) } }
    );
    return;
  }
  if (mode === 'inline') {
    setImmediate(() => {
      buildRunnerDeps()
        .then(deps => runMatch(matchId, options, deps))
        .catch(err => console.error(`Inline run of match ${matchId} failed:`, err));
    });
  }
};
