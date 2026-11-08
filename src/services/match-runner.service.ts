import { randomUUID } from 'crypto';
import { MatchStatus } from '@prisma/client';
import { GameEngine, GameEvent, GameResult, ModelAdapter } from '../game/types';
import { ModelUnavailableError } from '../game/adapters';
import { LeaseLostError, MoveUsage } from '../repositories/match.repository';
import { RateLimiter } from './rate-limit.service';
import { estimateTokens } from './usage-estimate';
import { MetricFields, logMetric } from './metrics.service';

export interface RunnerParticipant {
  id: string;
  role: string | null;
  model: { api_provider: string; api_model_id: string };
}

export interface RunnerMatch {
  id: string;
  game_type: string;
  seed: number;
  options?: any;
  engine_artifact_id?: string | null;
  status?: MatchStatus;
  move_failures?: number;
  started_at?: Date | null;
  input_tokens?: number;
  output_tokens?: number;
  participants: RunnerParticipant[];
}

export interface StoredMove {
  move_index: number;
  actor_role: string;
  content: string;
}

export interface RunnerEventRow {
  turn_index: number;
  seq: number;
  type: string;
  actor_role: string;
  payload: any;
}

export interface RunnerRepo {
  findForRun(id: string): Promise<RunnerMatch | null>;
  updateStatus(id: string, status: MatchStatus, finishedAt?: Date, failureReason?: string | null): Promise<unknown>;
  getStatus(id: string): Promise<MatchStatus | null>;
  transitionStatus(id: string, from: MatchStatus[], to: MatchStatus, finishedAt?: Date, failureReason?: string | null): Promise<boolean>;
  clearEvents(matchId: string): Promise<unknown>;
  addEvents(matchId: string, events: RunnerEventRow[]): Promise<unknown>;
  setParticipantScore(participantId: string, score: number): Promise<unknown>;
  acquireLease(id: string, owner: string, ttlMs: number, statuses: MatchStatus[]): Promise<boolean>;
  renewLease(id: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(id: string, owner: string): Promise<void>;
  getMoves(id: string): Promise<StoredMove[]>;
  countEvents(id: string): Promise<number>;
  recordMove(id: string, move: { index: number; actor: string; content: string; usage?: MoveUsage }, events: RunnerEventRow[]): Promise<void>;
  recordMoveFailure(id: string): Promise<number>;
  resetMoveFailures(id: string): Promise<unknown>;
  setRulesetVersion?(id: string, version: string): Promise<unknown>;
  markStarted?(id: string): Promise<unknown>;
  addRateLimitWait?(id: string): Promise<unknown>;
}

export interface RunnerDeps {
  repo: RunnerRepo;
  getEngine: (gameType: string, artifactId?: string | null) => Promise<GameEngine>;
  getAdapter: (provider: string, modelId: string) => ModelAdapter;
  maxTurns: number;
  /** Consecutive failed model calls tolerated for one move before the match fails. */
  moveAttempts?: number;
  backoffMs?: number;
  /** Cap for a single model call. It is shortened further so the call always fits in the slice. */
  moveTimeoutMs?: number;
  leaseTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Shared provider rate limiter; unset means calls are not throttled by us. */
  limiter?: RateLimiter;
  /** Budgets: a match that exceeds either is failed, so a runaway game cannot burn unbounded time or money. */
  maxWallMs?: number;
  maxInputTokens?: number;
  /** Model output longer than this is truncated before it is stored or played. */
  maxMoveChars?: number;
  metric?: (name: string, fields: MetricFields) => void;
}

export interface SliceOptions {
  /** Epoch ms after which no new model call may start. Defaults to no limit. */
  deadlineAt?: number;
  owner?: string;
  /** Also resume matches in FAILED state (queue-driven retries). Cancelled and completed matches never resume. */
  resumeFailed?: boolean;
}

export type SliceStatus = 'completed' | 'cancelled' | 'failed' | 'yielded' | 'busy' | 'finished' | 'lost';

export interface SliceResult {
  /** True when nothing more can be done for this match (completed, cancelled, failed, or already finished). */
  done: boolean;
  status: SliceStatus;
}

const DEFAULT_MOVE_TIMEOUT_MS = 60_000;

/**
 * Mock models normally answer instantly. A model id of the form `latency-<ms>` makes a mock behave like a slow provider
 * (it waits, then plays a random legal move), so slicing, hand-offs and load can be tested for real without API keys or
 * cost. Capped at one minute per move.
 */
export const mockLatencyMs = (modelId: string): number => {
  const match = /^latency-(\d{1,6})$/.exec(modelId || '');
  return match ? Math.min(Number(match[1]), 60_000) : 0;
};

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Plays a match for as long as the slice allows, then yields.
 *
 * All state lives in the database: the seed and options on the match plus the ordered move log. A new
 * slice (in any process) rebuilds the engine by replaying the log, which is deterministic and needs no
 * model calls, and carries on from there. A lease guarantees one runner at a time; the unique
 * (match, move_index) key makes recording a move exactly-once even if two runners race.
 */
export const runMatchSlice = async (matchId: string, jobOptions: any, deps: RunnerDeps, opts: SliceOptions = {}): Promise<SliceResult> => {
  const metric = deps.metric ?? logMetric;
  const clock = deps.now ?? Date.now;
  const started = clock();
  const stats = { moves: 0, modelCalls: 0 };
  try {
    const result = await runSliceInner(matchId, jobOptions, deps, opts, stats);
    metric('match.slice', { matchId, status: result.status, done: result.done, moves: stats.moves, modelCalls: stats.modelCalls, durationMs: clock() - started });
    return result;
  } catch (err: any) {
    metric('match.slice', { matchId, status: 'error', done: true, moves: stats.moves, modelCalls: stats.modelCalls, durationMs: clock() - started, error: String(err?.message || err).slice(0, 200) });
    throw err;
  }
};

const runSliceInner = async (
  matchId: string,
  jobOptions: any,
  deps: RunnerDeps,
  opts: SliceOptions,
  stats: { moves: number; modelCalls: number }
): Promise<SliceResult> => {
  const { repo } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const maxFailures = Math.max(1, deps.moveAttempts ?? 3);
  const backoff = deps.backoffMs ?? 1000;
  const moveTimeoutMs = deps.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
  const leaseTtlMs = deps.leaseTtlMs ?? moveTimeoutMs * 2;
  const owner = opts.owner ?? randomUUID();
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY;
  const maxMoveChars = deps.maxMoveChars ?? 4000;
  const metric = deps.metric ?? logMetric;

  const match = await repo.findForRun(matchId);
  if (!match) throw new Error('Match not found');

  const allowed: MatchStatus[] = [MatchStatus.PENDING, MatchStatus.RUNNING, ...(opts.resumeFailed ? [MatchStatus.FAILED] : [])];
  if (match.status && !allowed.includes(match.status)) {
    return { done: true, status: 'finished' };
  }
  if (!(await repo.acquireLease(matchId, owner, leaseTtlMs, allowed))) {
    // Another runner owns it (or it finished/cancelled between the read and now).
    const status = await repo.getStatus(matchId);
    const terminal = status !== null && !allowed.includes(status);
    return { done: terminal, status: terminal ? 'finished' : 'busy' };
  }

  let engine: GameEngine | null = null;
  try {
    await repo.updateStatus(matchId, MatchStatus.RUNNING, undefined, null);
    await repo.markStarted?.(matchId);
    const startedAt = match.started_at ? new Date(match.started_at).getTime() : now();
    let inputTokens = match.input_tokens ?? 0;
    // Resuming after a failure starts the retry budget afresh.
    if (match.status === MatchStatus.FAILED && (match.move_failures ?? 0) > 0) await repo.resetMoveFailures(matchId);

    const stored = await repo.getMoves(matchId);
    if (stored.length === 0) {
      // Nothing recorded yet: any events present are stale (e.g. an interrupted start), so begin cleanly.
      await repo.clearEvents(matchId);
    }

    engine = await deps.getEngine(match.game_type, match.engine_artifact_id);
    const options = jobOptions ?? match.options ?? {};
    const state: GameEvent[] = [...(engine.initialize(match.seed, options) || [])];
    let nextSeq = state.length;
    let result: GameResult | null = null;

    const rows = (events: GameEvent[], from: number): RunnerEventRow[] =>
      events.map((e, i) => ({ turn_index: e.turn, seq: from + i, type: e.type, actor_role: e.actor, payload: e.payload ?? {} }));

    if (stored.length === 0) {
      await repo.addEvents(matchId, rows(state, 0));
      const version = state[0]?.payload?.ruleset_version;
      if (typeof version === 'string' && repo.setRulesetVersion) await repo.setRulesetVersion(matchId, version);
    } else {
      // Rebuild the engine to exactly where the last slice stopped.
      for (const move of stored) {
        const step = engine.processMove(state, { actor: move.actor_role, content: move.content });
        state.push(...step.events);
        result = step.result;
      }
      const persisted = await repo.countEvents(matchId);
      if (persisted !== state.length) {
        throw new Error(`Replay diverged for match ${matchId}: engine produced ${state.length} events, ${persisted} are stored. The engine is not deterministic.`);
      }
      nextSeq = state.length;
    }

    const players = match.participants.map((p, index) => ({
      participant: p,
      role: p.role || `player${index + 1}`,
      adapter: deps.getAdapter(p.model.api_provider, p.model.api_model_id)
    }));
    if (players.length === 0) throw new Error('Match has no participants');

    let moveIndex = stored.length;
    let failures = match.status === MatchStatus.FAILED ? 0 : (match.move_failures ?? 0);
    let cancelled = false;
    let lost = false;
    let yielded = false;

    /** Waits for `ms` if that still leaves room for a model call in this slice; false means yield instead. */
    const waitIfItFits = async (ms: number): Promise<boolean> => {
      if (ms > deadlineAt - now() - moveTimeoutMs) return false;
      await sleep(Math.min(ms, 60_000));
      return true;
    };

    /**
     * Calls the model within the time left in this slice. Returns null when the slice has to yield.
     * Provider throttling (ours or theirs) means waiting, not failing; only genuine errors use the retry budget.
     */
    const generate = async (
      adapter: ModelAdapter,
      provider: string,
      role: string,
      systemPrompt: string,
      history: GameEvent[]
    ): Promise<{ content: string; usage: MoveUsage } | null> => {
      const estimatedInput = estimateTokens(systemPrompt + JSON.stringify(history));
      let throttled = 0;
      for (;;) {
        // A call only starts if its whole timeout fits in the slice; cutting it short would turn slow but
        // valid answers into failures. Otherwise yield and let the next slice make the call.
        if (deadlineAt - now() < moveTimeoutMs) return null;

        if (deps.limiter && provider !== 'composite') {
          const grant = await deps.limiter.acquire(provider, estimatedInput);
          if (!grant.allowed) {
            await repo.addRateLimitWait?.(matchId);
            metric('provider.throttled', { provider, source: 'local', waitMs: grant.retryAfterMs });
            if (!(await waitIfItFits(grant.retryAfterMs))) return null;
            continue;
          }
        }

        const callStarted = now();
        try {
          const raw = await adapter.generateMove(systemPrompt, history, role, { timeoutMs: moveTimeoutMs });
          const content = raw.length > maxMoveChars ? raw.slice(0, maxMoveChars) : raw;
          const usage = { provider, latencyMs: now() - callStarted, inputTokens: estimatedInput, outputTokens: estimateTokens(content) };
          metric('provider.call', { provider, ok: true, latencyMs: usage.latencyMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
          return { content, usage };
        } catch (err) {
          if (err instanceof ModelUnavailableError && err.rateLimited) {
            throttled++;
            await repo.addRateLimitWait?.(matchId);
            metric('provider.throttled', { provider, source: 'provider', waitMs: err.retryAfterMs ?? 5000 });
            if (throttled > 20) throw new ModelUnavailableError(`Provider ${provider} kept rate limiting this match`, err);
            if (!(await waitIfItFits(err.retryAfterMs ?? 5000))) return null;
            continue;
          }
          metric('provider.call', { provider, ok: false, latencyMs: now() - callStarted, error: String((err as Error)?.message || err).slice(0, 200) });
          failures = await repo.recordMoveFailure(matchId);
          deps.log?.(`Model call failed for ${role} (${failures}/${maxFailures}): ${(err as Error)?.message}`);
          if (failures >= maxFailures) {
            throw new ModelUnavailableError(
              `Model for ${role} unavailable after ${failures} attempts: ${(err as Error)?.message || err}`,
              err
            );
          }
          await sleep(Math.min(backoff * failures * failures, Math.max(0, deadlineAt - now())));
        }
      }
    };

    const failBudget = async (reason: string): Promise<SliceResult> => {
      await repo.addEvents(matchId, rows([{
        turn: (state[state.length - 1]?.turn ?? 0) + 1,
        actor: 'system',
        type: 'MATCH_BUDGET_EXCEEDED',
        payload: { reason }
      }], nextSeq));
      await repo.transitionStatus(matchId, [MatchStatus.RUNNING], MatchStatus.FAILED, undefined, reason);
      await repo.releaseLease(matchId, owner);
      metric('match.budget_exceeded', { matchId, reason });
      return { done: true, status: 'failed' };
    };

    let turnCount = stored.length;
    while (!result && turnCount < deps.maxTurns) {
      if (!(await repo.renewLease(matchId, owner, leaseTtlMs))) {
        // Either an admin cancelled the match or another runner took over after our lease lapsed.
        if ((await repo.getStatus(matchId)) === MatchStatus.CANCELLED) cancelled = true;
        else lost = true;
        break;
      }

      if (deps.maxWallMs && now() - startedAt > deps.maxWallMs) {
        return failBudget(`Exceeded the time budget of ${Math.round(deps.maxWallMs / 60_000)} minutes`);
      }
      if (deps.maxInputTokens && inputTokens > deps.maxInputTokens) {
        return failBudget(`Exceeded the token budget of ${deps.maxInputTokens.toLocaleString('en-US')} input tokens`);
      }

      let activeRole = engine.getActiveRole ? engine.getActiveRole(state) : null;
      if (!activeRole) activeRole = players[turnCount % players.length].role;

      let usage: MoveUsage | undefined;
      let content: string;
      if (activeRole === 'system') {
        content = 'RESOLVE';
      } else {
        const player = players.find(p => p.role === activeRole);
        if (!player) throw new Error(`No participant is assigned to role "${activeRole}"`);
        if (engine.isAutomatic?.(state, activeRole)) {
          content = 'ACK';
        } else if (player.participant.model.api_provider === 'mock') {
          const latency = mockLatencyMs(player.participant.model.api_model_id);
          if (latency > 0) {
            // Same rule as a real call: only start waiting if the move will finish inside this slice.
            if (deadlineAt - now() < latency) {
              yielded = true;
              break;
            }
            await sleep(latency);
            usage = { provider: 'mock', latencyMs: latency, inputTokens: estimateTokens(JSON.stringify(state)), outputTokens: 1 };
            stats.modelCalls++;
          }
          content = engine.getRandomMove(state, activeRole).content;
        } else {
          const observation = engine.getObservation ? engine.getObservation(state, activeRole) : state;
          const generated = await generate(player.adapter, player.participant.model.api_provider, activeRole, engine.getSystemPrompt(activeRole), observation);
          if (generated === null) {
            yielded = true;
            break;
          }
          content = generated.content;
          usage = generated.usage;
          stats.modelCalls++;
        }
      }

      const step = engine.processMove(state, { actor: activeRole, content });
      try {
        await repo.recordMove(matchId, { index: moveIndex, actor: activeRole, content, usage }, rows(step.events, nextSeq));
      } catch (err) {
        if (err instanceof LeaseLostError) {
          lost = true;
          break;
        }
        throw err;
      }
      failures = 0;
      if (usage) inputTokens += usage.inputTokens;
      stats.moves++;
      moveIndex++;
      nextSeq += step.events.length;
      state.push(...step.events);
      result = step.result;
      turnCount++;
    }

    if (lost) return { done: false, status: 'lost' };

    if (cancelled) {
      await repo.addEvents(matchId, rows([{
        turn: (state[state.length - 1]?.turn ?? 0) + 1,
        actor: 'system',
        type: 'MATCH_CANCELLED',
        payload: { reason: 'Cancelled by an administrator' }
      }], nextSeq));
      await repo.releaseLease(matchId, owner);
      return { done: true, status: 'cancelled' };
    }

    if (yielded) {
      await repo.releaseLease(matchId, owner);
      return { done: false, status: 'yielded' };
    }

    if (result) {
      for (const [role, score] of Object.entries(result.scores || {})) {
        const player = players.find(p => p.role === role);
        if (player && Number.isFinite(score)) await repo.setParticipantScore(player.participant.id, score);
      }
      await repo.transitionStatus(matchId, [MatchStatus.RUNNING], MatchStatus.COMPLETED, new Date(), null);
    } else {
      const reason = `Stopped after ${deps.maxTurns} turns without a result`;
      await repo.addEvents(matchId, rows([{
        turn: (state[state.length - 1]?.turn ?? 0) + 1,
        actor: 'system',
        type: 'MATCH_TRUNCATED',
        payload: { reason, max_turns: deps.maxTurns }
      }], nextSeq));
      await repo.transitionStatus(matchId, [MatchStatus.RUNNING], MatchStatus.COMPLETED, new Date(), reason);
    }
    await repo.releaseLease(matchId, owner);
    return { done: true, status: 'completed' };
  } catch (error: any) {
    if (error instanceof LeaseLostError) return { done: false, status: 'lost' };
    const reason = String(error?.message || error).slice(0, 1000);
    await repo.transitionStatus(matchId, [MatchStatus.RUNNING, MatchStatus.PENDING], MatchStatus.FAILED, undefined, reason);
    await repo.releaseLease(matchId, owner).catch(() => undefined);
    throw error;
  } finally {
    engine?.dispose?.();
  }
};

/**
 * Runs a match to the end in one go (queue workers and local dev, where there is no time limit).
 * Safe to call again for the same match: it resumes from the recorded moves.
 */
export const runMatch = async (matchId: string, jobOptions: any, deps: RunnerDeps) => {
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = (deps.leaseTtlMs ?? (deps.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS) * 2) / 12;
  // A previous worker may have died holding the lease; it lapses within its TTL, so wait for it.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await runMatchSlice(matchId, jobOptions, deps, { resumeFailed: true });
    if (result.status !== 'busy' && result.status !== 'lost') return result;
    await sleep(waitMs);
  }
  throw new Error('Match is still locked by another runner');
};
