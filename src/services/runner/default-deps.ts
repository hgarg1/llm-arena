import { MatchRepository } from '../../repositories/match.repository';
import { getGameEngine } from '../../game/registry';
import { getModelAdapter } from '../../game/adapters';
import { settingsService } from '../settings.service';
import { RunnerDeps, RunnerRepo } from '../match-runner.service';
import { createDbRateLimiter } from '../rate-limit.service';
import { logMetric } from '../metrics.service';

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const matchRepo = new MatchRepository();

/** The production wiring of the runner: real repository, registry, adapters and admin-tunable limits. */
export const buildRunnerDeps = async (): Promise<RunnerDeps> => {
  // Read per run so admin changes apply without a restart.
  const settings = await settingsService.getAll();
  const maxTurns = Math.max(1, parseInt(settings.queue_max_turns || '250', 10));
  const moveTimeoutMs = Number(process.env.MATCH_MOVE_TIMEOUT_MS) || 60_000;
  return {
    repo: matchRepo as unknown as RunnerRepo,
    getEngine: getGameEngine,
    getAdapter: getModelAdapter,
    maxTurns,
    moveTimeoutMs,
    limiter: createDbRateLimiter(),
    maxWallMs: numberFromEnv('MATCH_MAX_WALL_MINUTES', 240) * 60_000,
    maxInputTokens: numberFromEnv('MATCH_MAX_INPUT_TOKENS', 5_000_000),
    metric: logMetric,
    log: message => console.warn(message)
  };
};
