import { MatchStatus } from '@prisma/client';
import { runMatchSlice, RunnerDeps, RunnerMatch } from '../src/services/match-runner.service';
import { ModelUnavailableError } from '../src/game/adapters';
import { getGameEngine } from '../src/game/registry';
import { ModelAdapter } from '../src/game/types';
import { RateLimiter } from '../src/services/rate-limit.service';
import { MemoryRepo, participants } from './helpers/memory-repo';
import { scriptedAdapter } from './helpers/scripted-adapter';

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn() } } }));

const mk = (game = 'chess', roles = ['white', 'black'], provider = 'openai'): RunnerMatch =>
  ({ id: 'm1', game_type: game, seed: 5, participants: participants(provider, roles) });

const clockEnv = (callMs = 1000) => {
  const clock = { t: 1_000_000 };
  const adapter = (): ModelAdapter => {
    const inner = scriptedAdapter();
    return { generateMove: async (p, h, r, o) => { clock.t += callMs; return inner.generateMove(p, h, r, o); } };
  };
  return { clock, now: () => clock.t, adapter };
};

const base = (repo: MemoryRepo, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  repo, getEngine: getGameEngine, getAdapter: () => scriptedAdapter(), maxTurns: 600,
  sleep: async () => undefined, metric: () => undefined, ...extra
});

describe('provider rate limiting (ours)', () => {
  it('waits for the limiter, then makes the call; waiting is counted, not treated as failure', async () => {
    const env = clockEnv();
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    const decisions = [{ allowed: false as const, retryAfterMs: 2000 }, { allowed: false as const, retryAfterMs: 500 }];
    const limiter: RateLimiter = { acquire: jest.fn(async () => decisions.shift() ?? { allowed: true as const }) };
    const sleeps: number[] = [];
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: env.adapter, now: env.now, limiter, sleep: async ms => { sleeps.push(ms); env.clock.t += ms; } }));
    expect(sleeps.slice(0, 2)).toEqual([2000, 500]);
    expect(repo.rateLimitWaits).toBe(2);
    expect(repo.moveFailures).toBe(0);
    expect(repo.status).toBe(MatchStatus.COMPLETED);
  });

  it('asks the limiter per provider with an estimate of the prompt size', async () => {
    const repo = new MemoryRepo(mk('texas_holdem', ['seat1', 'seat2']));
    const acquire = jest.fn(async () => ({ allowed: true as const }));
    await runMatchSlice('m1', { playerCount: 2 }, base(repo, { limiter: { acquire } }));
    expect(acquire).toHaveBeenCalled();
    const [provider, tokens] = acquire.mock.calls[0] as unknown as [string, number];
    expect(provider).toBe('openai');
    expect(tokens).toBeGreaterThan(10);
  });

  it('yields (does not sleep past the slice) when the wait will not fit, without consuming a call', async () => {
    const env = clockEnv();
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    const generateMove = jest.fn();
    const limiter: RateLimiter = { acquire: async () => ({ allowed: false, retryAfterMs: 120_000 }) };
    const result = await runMatchSlice('m1', {}, base(repo, { getAdapter: () => ({ generateMove }), now: env.now, limiter, moveTimeoutMs: 60_000 }), { deadlineAt: env.now() + 130_000 });
    expect(result).toEqual({ done: false, status: 'yielded' });
    expect(generateMove).not.toHaveBeenCalled();
    expect(repo.moves).toHaveLength(0);
  });

  it('never throttles engine-driven moves or mock models', async () => {
    const acquire = jest.fn(async () => ({ allowed: false as const, retryAfterMs: 1 }));
    const chutes = new MemoryRepo(mk('chutes_and_ladders', ['player1']));
    await runMatchSlice('m1', {}, base(chutes, { limiter: { acquire } }));
    const mock = new MemoryRepo(mk('chess', ['white', 'black'], 'mock'));
    await runMatchSlice('m1', { maxPlies: 24 }, base(mock, { limiter: { acquire } }));
    expect(acquire).not.toHaveBeenCalled();
  });

  it('composite models are not throttled as one provider (their members are)', async () => {
    const acquire = jest.fn(async () => ({ allowed: true as const }));
    const repo = new MemoryRepo(mk('chess', ['white', 'black'], 'composite'));
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { limiter: { acquire }, getAdapter: () => scriptedAdapter() }));
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('provider 429s', () => {
  const limited = (retryAfterMs?: number) => new ModelUnavailableError('429', undefined, { rateLimited: true, retryAfterMs });

  it('waits for Retry-After and does not use up the retry budget', async () => {
    let calls = 0;
    const adapter: ModelAdapter = { generateMove: async (p, h, r) => { if (++calls <= 5) throw limited(3000); return scriptedAdapter().generateMove(p, h, r); } };
    const repo = new MemoryRepo(mk());
    const sleeps: number[] = [];
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: () => adapter, sleep: async ms => { sleeps.push(ms); } }));
    expect(repo.status).toBe(MatchStatus.COMPLETED); // five 429s in a row would have failed a 3-attempt budget
    expect(sleeps.slice(0, 5)).toEqual([3000, 3000, 3000, 3000, 3000]);
    expect(repo.rateLimitWaits).toBe(5);
  });

  it('uses a 5 s default when the provider gives no Retry-After', async () => {
    let calls = 0;
    const adapter: ModelAdapter = { generateMove: async (p, h, r) => { if (++calls === 1) throw limited(); return scriptedAdapter().generateMove(p, h, r); } };
    const sleeps: number[] = [];
    await runMatchSlice('m1', { maxPlies: 24 }, base(new MemoryRepo(mk()), { getAdapter: () => adapter, sleep: async ms => { sleeps.push(ms); } }));
    expect(sleeps[0]).toBe(5000);
  });

  it('yields instead of sleeping when the slice cannot absorb the wait', async () => {
    const env = clockEnv();
    const adapter: ModelAdapter = { generateMove: async () => { throw limited(100_000); } };
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    const result = await runMatchSlice('m1', {}, base(repo, { getAdapter: () => adapter, now: env.now, moveTimeoutMs: 60_000 }), { deadlineAt: env.now() + 130_000 });
    expect(result.status).toBe('yielded');
    expect(repo.moveFailures).toBe(0);
  });

  it('gives up with a clear error if the provider keeps rate limiting forever', async () => {
    const adapter: ModelAdapter = { generateMove: async () => { throw limited(1000); } };
    const repo = new MemoryRepo(mk());
    await expect(runMatchSlice('m1', {}, base(repo, { getAdapter: () => adapter }))).rejects.toThrow(/kept rate limiting/);
    expect(repo.status).toBe(MatchStatus.FAILED);
  });

  it('ordinary errors still use the retry budget', async () => {
    const adapter: ModelAdapter = { generateMove: async () => { throw new ModelUnavailableError('500'); } };
    const repo = new MemoryRepo(mk());
    await expect(runMatchSlice('m1', {}, base(repo, { getAdapter: () => adapter }))).rejects.toThrow(/after 3 attempts/);
  });
});

describe('budgets', () => {
  it('fails a match that exceeds its wall-time budget, keeping what was played', async () => {
    const env = clockEnv(60_000);
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    const result = await runMatchSlice('m1', { maxPlies: 100 }, base(repo, { getAdapter: env.adapter, now: env.now, maxWallMs: 5 * 60_000 }));
    expect(result).toEqual({ done: true, status: 'failed' });
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(repo.statusLog[repo.statusLog.length - 1].reason).toMatch(/time budget of 5 minutes/);
    expect(repo.events[repo.events.length - 1].type).toBe('MATCH_BUDGET_EXCEEDED');
    expect(repo.moves.length).toBeGreaterThanOrEqual(5);
    expect(repo.moves.length).toBeLessThan(10);
    expect(repo.leaseOwner).toBeNull();
  });

  it('the wall-time budget counts from the first start, across slices (queue wait excluded)', async () => {
    const env = clockEnv(60_000);
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    env.clock.t += 3_600_000; // an hour in the queue does not count
    const d = base(repo, { getAdapter: env.adapter, now: env.now, maxWallMs: 6 * 60_000, moveTimeoutMs: 60_000 });
    let result = await runMatchSlice('m1', { maxPlies: 100 }, d, { deadlineAt: env.now() + 180_000 });
    expect(result.status).toBe('yielded');
    result = await runMatchSlice('m1', { maxPlies: 100 }, d, { deadlineAt: env.now() + 180_000 });
    expect(['yielded', 'failed']).toContain(result.status);
    for (let i = 0; i < 5 && !result.done; i++) result = await runMatchSlice('m1', { maxPlies: 100 }, d, { deadlineAt: env.now() + 180_000 });
    expect(result.status).toBe('failed');
    expect(repo.startedAt!.getTime()).toBe(1_000_000 + 3_600_000);
  });

  it('fails a match that exceeds its input-token budget', async () => {
    const repo = new MemoryRepo(mk());
    const result = await runMatchSlice('m1', { maxPlies: 100 }, base(repo, { maxInputTokens: 1000 }));
    expect(result.status).toBe('failed');
    expect(repo.statusLog[repo.statusLog.length - 1].reason).toMatch(/token budget of 1,000/);
    expect(repo.inputTokens).toBeGreaterThan(1000);
  });

  it('token usage carries across slices and replays', async () => {
    const repo = new MemoryRepo(mk());
    repo.inputTokens = 999_000; // a previous slice already spent almost everything
    const result = await runMatchSlice('m1', { maxPlies: 100 }, base(repo, { maxInputTokens: 1_000_000 }));
    expect(result.status).toBe('failed');
  });

  it('no budgets means no limits', async () => {
    const repo = new MemoryRepo(mk());
    expect((await runMatchSlice('m1', { maxPlies: 24 }, base(repo))).status).toBe('completed');
  });

  it('a failed-by-budget match is final: the driver must not chain or retry', async () => {
    const repo = new MemoryRepo(mk());
    const result = await runMatchSlice('m1', { maxPlies: 100 }, base(repo, { maxInputTokens: 10 }));
    expect(result.done).toBe(true);
  });
});

describe('accounting, truncation and metrics', () => {
  it('records provider, latency and token estimates for every model move, and none for engine moves', async () => {
    const env = clockEnv(1500);
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: env.adapter, now: env.now }));
    expect(repo.usage).toHaveLength(24);
    expect(repo.usage[0]).toMatchObject({ provider: 'openai', latencyMs: 1500 });
    expect(repo.usage.every(u => u.inputTokens > 0 && u.outputTokens > 0)).toBe(true);
    expect(repo.inputTokens).toBe(repo.usage.reduce((a, u) => a + u.inputTokens, 0));
    const chutes = new MemoryRepo(mk('chutes_and_ladders', ['player1']));
    await runMatchSlice('m1', {}, base(chutes));
    expect(chutes.usage).toHaveLength(0);
  });

  it('truncates absurdly long model output before it is stored or played', async () => {
    const adapter: ModelAdapter = { generateMove: async () => 'e2e4' + ' blah'.repeat(5000) };
    const repo = new MemoryRepo(mk());
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: () => adapter, maxMoveChars: 100 }));
    expect(repo.moves[0].content.length).toBe(100);
    expect(repo.moves[0].content.startsWith('e2e4')).toBe(true);
  });

  it('stamps the start time once', async () => {
    const env = clockEnv();
    const repo = new MemoryRepo(mk(), MatchStatus.PENDING, env.now);
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: env.adapter, now: env.now }), { deadlineAt: env.now() + 130_000 });
    const first = repo.startedAt!.getTime();
    env.clock.t += 10_000;
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { getAdapter: env.adapter, now: env.now }), { deadlineAt: env.now() + 130_000 });
    expect(repo.startedAt!.getTime()).toBe(first);
  });

  it('emits structured metrics for every call and every slice', async () => {
    const events: Array<{ name: string; fields: any }> = [];
    const repo = new MemoryRepo(mk('texas_holdem', ['seat1', 'seat2']));
    await runMatchSlice('m1', { playerCount: 2 }, base(repo, { metric: (name, fields) => events.push({ name, fields }) }));
    const calls = events.filter(e => e.name === 'provider.call');
    const slices = events.filter(e => e.name === 'match.slice');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fields).toMatchObject({ provider: 'openai', ok: true });
    expect(slices).toHaveLength(1);
    expect(slices[0].fields).toMatchObject({ matchId: 'm1', status: 'completed', done: true, modelCalls: calls.length });
    expect(slices[0].fields.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failed calls and slice errors as metrics too', async () => {
    const events: Array<{ name: string; fields: any }> = [];
    const adapter: ModelAdapter = { generateMove: async () => { throw new ModelUnavailableError('boom'); } };
    const repo = new MemoryRepo(mk());
    await expect(runMatchSlice('m1', {}, base(repo, { getAdapter: () => adapter, metric: (name, fields) => events.push({ name, fields }) }))).rejects.toThrow();
    expect(events.filter(e => e.name === 'provider.call' && e.fields.ok === false)).toHaveLength(3);
    expect(events.find(e => e.name === 'match.slice')!.fields).toMatchObject({ status: 'error' });
  });
});

describe('mock models with simulated latency', () => {
  const { mockLatencyMs } = require('../src/services/match-runner.service');
  const latencyMatch = (id = 'latency-1500', game = 'chess', roles = ['white', 'black']): RunnerMatch => ({
    id: 'm1', game_type: game, seed: 5,
    participants: roles.map((role, i) => ({ id: `p${i + 1}`, role, model: { api_provider: 'mock', api_model_id: id } }))
  });
  const timeline = () => {
    const clock = { t: 1_000_000 };
    return { clock, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
  };

  it('parses latency-<ms> model ids, capped at a minute, and treats everything else as instant', () => {
    expect(mockLatencyMs('latency-1500')).toBe(1500);
    expect(mockLatencyMs('latency-0')).toBe(0);
    expect(mockLatencyMs('latency-999999')).toBe(60_000);
    for (const other of ['mock-random', 'latency-', 'latency-12ms', 'LATENCY-5', ' latency-5', '', undefined]) expect(mockLatencyMs(other as any)).toBe(0);
  });

  it('waits the simulated latency for every move and records it as usage', async () => {
    const t = timeline();
    const repo = new MemoryRepo(latencyMatch(), MatchStatus.PENDING, t.now);
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { now: t.now, sleep: t.sleep }));
    expect(t.clock.t - 1_000_000).toBe(24 * 1500);
    expect(repo.usage).toHaveLength(24);
    expect(repo.usage[0]).toMatchObject({ provider: 'mock', latencyMs: 1500 });
    expect(repo.status).toBe(MatchStatus.COMPLETED);
  });

  it('plain mock models stay instant and record no usage', async () => {
    const t = timeline();
    const repo = new MemoryRepo(latencyMatch('mock-random'), MatchStatus.PENDING, t.now);
    await runMatchSlice('m1', { maxPlies: 24 }, base(repo, { now: t.now, sleep: t.sleep }));
    expect(t.clock.t).toBe(1_000_000);
    expect(repo.usage).toHaveLength(0);
  });

  it('yields when the next simulated move would not fit in the slice, and the next slice continues to the end', async () => {
    const t = timeline();
    const repo = new MemoryRepo(latencyMatch('latency-10000'), MatchStatus.PENDING, t.now);
    const d = base(repo, { now: t.now, sleep: t.sleep });
    const first = await runMatchSlice('m1', { maxPlies: 30 }, d, { deadlineAt: t.now() + 35_000 });
    expect(first).toEqual({ done: false, status: 'yielded' });
    expect(repo.moves).toHaveLength(3); // 3 x 10s fit in 35s, the 4th would not
    let result = first;
    let slices = 1;
    while (!result.done && slices < 20) { result = await runMatchSlice('m1', { maxPlies: 30 }, d, { deadlineAt: t.now() + 35_000 }); slices++; }
    expect(result.status).toBe('completed');
    expect(repo.moves).toHaveLength(30);
    expect(slices).toBe(10);
  });

  it('a latency match played across many slices is internally consistent: its stored moves replay to exactly its stored events', async () => {
    // (Not compared with an uninterrupted run: a mock draws random moves from the engine's own RNG, which a resumed slice
    // does not consume while replaying. What must hold is that the persisted moves reproduce the persisted events.)
    for (const perSlice of [1, 2, 5]) {
      const t = timeline();
      const repo = new MemoryRepo(latencyMatch('latency-2000', 'texas_holdem', ['seat1', 'seat2', 'seat3']), MatchStatus.PENDING, t.now);
      const d = base(repo, { now: t.now, sleep: t.sleep });
      let r: any = { done: false };
      let guard = 0;
      while (!r.done && guard++ < 200) r = await runMatchSlice('m1', { playerCount: 3 }, d, { deadlineAt: t.now() + 2000 * perSlice });
      expect(r.status).toBe('completed');

      const fresh = await getGameEngine('texas_holdem');
      const replayed: any[] = [...fresh.initialize(5, { playerCount: 3 })];
      for (const m of repo.moves) replayed.push(...fresh.processMove(replayed, { actor: m.actor_role, content: m.content }).events);
      expect(replayed.map((e: any) => `${e.type}:${JSON.stringify(e.payload)}`)).toEqual(repo.events.map(e => `${e.type}:${JSON.stringify(e.payload)}`));
      expect(repo.events.map(e => e.seq)).toEqual(repo.events.map((_, i) => i));
    }
  });
});
