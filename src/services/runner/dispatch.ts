import { getEnv, getSiteUrl } from '../../config/runtime';
import { signRunnerRequest } from './auth';

export const runnerBaseUrl = () => {
  const explicit = getEnv('MATCH_RUNNER_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const production = getEnv('VERCEL_PROJECT_PRODUCTION_URL');
  if (production) return `https://${production}`;
  return getSiteUrl().replace(/\/$/, '');
};

/**
 * Asks the slice function to run one slice of a match. The function answers 202 immediately and keeps
 * working in the background, so this returns quickly and never ties up the caller (a page request or
 * the previous slice). A lost dispatch is repaired by the cron sweeper.
 */
export const dispatchSlice = async (matchId: string, opts: { continuation?: boolean } = {}): Promise<boolean> => {
  try {
    const response = await fetch(`${runnerBaseUrl()}/api/internal/match-slice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRunnerRequest(matchId) },
      body: JSON.stringify({ matchId, continuation: Boolean(opts.continuation) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      console.warn(`Slice dispatch for match ${matchId} returned ${response.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`Slice dispatch for match ${matchId} failed: ${err?.message || err}`);
    return false;
  }
};
