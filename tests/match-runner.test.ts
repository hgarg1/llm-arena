import { MatchStatus } from '@prisma/client';
import { runMatch, runMatchSlice, RunnerDeps, RunnerMatch, SliceResult } from '../src/services/match-runner.service';
import { ModelUnavailableError, getModelAdapter } from '../src/game/adapters';
import { getGameEngine } from '../src/game/registry';
import { GameEngine, GameEvent, ModelAdapter } from '../src/game/types';
import { LeaseLostError } from '../src/repositories/match.repository';
import { MemoryRepo, participants } from './helpers/memory-repo';
import { scriptedAdapter } from './helpers/scripted-adapter';

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn() } } }));

const mkMatch = (game_type: string, roles: string[], provider = 'mock', over: Partial<RunnerMatch> = {}): RunnerMatch =>
  ({ id: 'm1', game_type, seed: 99, participants: participants(provider, roles), ...over });

const deps = (repo: MemoryRepo, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  repo,
  getEngine: getGameEngine,
  getAdapter: getModelAdapter,
  maxTurns: 600,
  sleep: async () => undefined,
  metric: () => undefined,
  ...extra
});

const run = (repo: MemoryRepo, d: RunnerDeps) => runMatch(repo.match.id, undefined, d);

describe('runMatch', () => {
  it('plays a full poker match with seeded random models, persists ordered events and scores', async () => {
    const repo = new MemoryRepo(mkMatch('texas_holdem', ['seat1', 'seat2', 'seat3']));
    await runMatch('m1', { playerCount: 3, startingStack: 200 }, deps(repo));

    expect(repo.statusLog.map(s => s.status)).toEqual([MatchStatus.RUNNING, MatchStatus.COMPLETED]);
    expect(repo.events[0].type).toBe('MATCH_START');
    expect(repo.events[repo.events.length - 1].type).toBe('RESULT');
    expect(repo.events.map(e => e.seq)).toEqual(repo.events.map((_, i) => i));
    expect(Object.keys(repo.scores).sort()).toEqual(['p1', 'p2', 'p3']);
    expect((repo.events[repo.events.length - 1].payload.final_stacks as number[]).reduce((a, b) => a + b, 0)).toBe(600);
    expect(repo.leaseOwner).toBeNull();
  });

  it('records every move so the match can be replayed elsewhere', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    await runMatch('m1', {}, deps(repo));
    expect(repo.moves.map(m => m.move_index)).toEqual(repo.moves.map((_, i) => i));
    expect(repo.moves.every(m => m.actor_role === 'player1' && m.content === 'ACK')).toBe(true);
    expect(repo.sliceCount).toBe(1);
  });

  it('records the ruleset version the engine reports', async () => {
    const repo = new MemoryRepo(mkMatch('texas_holdem', ['seat1', 'seat2']));
    await runMatch('m1', { playerCount: 2 }, deps(repo));
    expect(repo.rulesetVersion).toBe('2.0.0');
  });

  it('routes every move to the seat the engine says is next, and hides other hole cards', async () => {
    const asked: string[] = [];
    const adapter: ModelAdapter = {
      generateMove: async (_prompt, history, role) => {
        asked.push(role!);
        const seat = Number(role!.replace('seat', ''));
        history.filter(e => e.type === 'DEAL_HOLE_CARDS').forEach(e => expect(e.payload.seat).toBe(seat));
        return 'FOLD';
      }
    };
    const repo = new MemoryRepo(mkMatch('texas_holdem', ['seat1', 'seat2', 'seat3', 'seat4'], 'openai'));
    await runMatch('m1', { playerCount: 4, dealerIndex: 0 }, deps(repo, { getAdapter: () => adapter }));
    expect(asked).toEqual(['seat4', 'seat1', 'seat2']);
    expect(repo.events.find(e => e.type === 'POT_AWARDED')!.payload.seat).toBe(3);
  });

  it('does not call a model for chutes & ladders', async () => {
    const generateMove = jest.fn();
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1'], 'openai'));
    await runMatch('m1', {}, deps(repo, { getAdapter: () => ({ generateMove }) }));
    expect(generateMove).not.toHaveBeenCalled();
    expect(repo.status).toBe(MatchStatus.COMPLETED);
  });

  it('passes the per-call timeout to the model', async () => {
    const seen: Array<number | undefined> = [];
    const adapter: ModelAdapter = { generateMove: async (_p, _h, _r, options) => { seen.push(options?.timeoutMs); return 'FOLD'; } };
    const repo = new MemoryRepo(mkMatch('texas_holdem', ['seat1', 'seat2'], 'openai'));
    await runMatch('m1', { playerCount: 2 }, deps(repo, { getAdapter: () => adapter, moveTimeoutMs: 45_000 }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(t => t === 45_000)).toBe(true);
  });

  it('retries a flaky model with backoff and still plays the move', async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      generateMove: async () => {
        calls++;
        if (calls < 3) throw new ModelUnavailableError('503');
        return 'e2e4';
      }
    };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    const sleeps: number[] = [];
    const getAdapter = (_p: string, id: string) => (id === 'm1' ? adapter : ({ generateMove: async () => 'e2e5' } as ModelAdapter));
    await run(repo, deps(repo, { getAdapter, sleep: async ms => { sleeps.push(ms); } }));
    expect(repo.events.find(e => e.type === 'MOVE')!.payload.uci).toBe('e2e4');
    expect(sleeps).toEqual([1000, 4000]);
    expect(repo.moveFailures).toBe(0);
  });

  it('fails the match instead of forfeiting when a model stays unavailable', async () => {
    const adapter: ModelAdapter = { generateMove: async () => { throw new ModelUnavailableError('provider down'); } };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    await expect(run(repo, deps(repo, { getAdapter: () => adapter }))).rejects.toThrow(/unavailable after 3 attempts/);
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(repo.statusLog[repo.statusLog.length - 1].reason).toMatch(/provider down/);
    expect(repo.events.some(e => e.type === 'ILLEGAL_MOVE' || e.type === 'RESULT')).toBe(false);
    expect(repo.scores).toEqual({});
    expect(repo.leaseOwner).toBeNull();
  });

  it('a queue retry after a failure resumes from the recorded moves instead of replaying them', async () => {
    let failing = true;
    let attempts = 0;
    const calls: string[] = [];
    const adapter: ModelAdapter = {
      generateMove: async (_p, history, role) => {
        if (failing && ++attempts > 10) throw new ModelUnavailableError('flaky'); // the provider dies after 10 good calls
        calls.push(role!);
        return scriptedAdapter().generateMove('', history, role);
      }
    };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    const d = deps(repo, { getAdapter: () => adapter });
    await expect(runMatch('m1', { maxPlies: 40 }, d)).rejects.toThrow();
    const movesBefore = repo.moves.length;
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(movesBefore).toBeGreaterThan(2);

    failing = false;
    calls.length = 0;
    await runMatch('m1', { maxPlies: 40 }, d); // runMatch resumes FAILED matches
    expect(repo.status).toBe(MatchStatus.COMPLETED);
    expect(repo.moves.length).toBe(40);
    expect(calls.length).toBe(40 - movesBefore); // earlier moves were replayed for free, not re-asked
    expect(repo.events.map(e => e.seq)).toEqual(repo.events.map((_, i) => i));
  });

  it('records truncation when the turn limit is hit', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 1000 }, deps(repo, { maxTurns: 5 }));
    expect(repo.events[repo.events.length - 1].type).toBe('MATCH_TRUNCATED');
    const last = repo.statusLog[repo.statusLog.length - 1];
    expect(last.status).toBe(MatchStatus.COMPLETED);
    expect(last.reason).toMatch(/without a result/);
  });

  it('fails clearly when a role has no participant', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'observer']));
    await expect(run(repo, deps(repo))).rejects.toThrow(/role "black"/);
    expect(repo.status).toBe(MatchStatus.FAILED);
  });

  it('fails when the engine cannot be loaded', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await expect(run(repo, deps(repo, { getEngine: async () => { throw new Error('Published runtime not found'); } }))).rejects.toThrow(/not found/);
    expect(repo.status).toBe(MatchStatus.FAILED);
  });

  it('throws for an unknown match without touching state', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    repo.findForRun = async () => null as any;
    await expect(runMatch('missing', {}, deps(repo))).rejects.toThrow('Match not found');
    expect(repo.statusLog).toHaveLength(0);
  });

  it('runs blackjack to completion for several seats', async () => {
    const repo = new MemoryRepo(mkMatch('blackjack', ['seat1', 'seat2', 'seat3']));
    await runMatch('m1', { playerCount: 3, allowSplit: true, allowSurrender: true }, deps(repo));
    expect(repo.status).toBe(MatchStatus.COMPLETED);
    expect(repo.events.filter(e => e.type === 'HAND_RESULT').length).toBeGreaterThanOrEqual(3);
  });

  it('runs a generated engine from the database through the real runner', async () => {
    const { prisma } = jest.requireMock('../src/config/db');
    prisma.gameEngineArtifact.findFirst.mockResolvedValue({
      id: 'art-x', kind: 'SANDBOXED',
      code_ts: `export default class Race {
        n = 0;
        initialize() { this.n = 0; return [{ turn: 0, actor: 'system', type: 'START', payload: {} }]; }
        processMove(h: any, m: any) {
          this.n++;
          const events = [{ turn: h[h.length - 1].turn + 1, actor: m.actor, type: 'STEP', payload: { content: m.content } }];
          return { events, result: this.n >= 4 ? { isFinished: true, scores: { player1: 1, player2: 0 } } : null };
        }
        getSystemPrompt(r: string) { return 'run ' + r; }
        getRandomMove(h: any, r: string) { return { actor: r, content: 'go' }; }
      }`
    });
    const repo = new MemoryRepo(mkMatch('custom-race', ['player1', 'player2'], 'mock', { engine_artifact_id: 'art-x' }));
    await runMatch('m1', {}, deps(repo));
    expect(repo.events.filter(e => e.type === 'STEP')).toHaveLength(4);
    expect(repo.scores).toEqual({ p1: 1, p2: 0 });
  });
});

describe('cancellation', () => {
  it('stops between moves when an admin cancels, and keeps the CANCELLED status', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    let moves = 0;
    const adapter: ModelAdapter = { generateMove: async () => { moves++; if (moves === 2) repo.cancel(); return moves % 2 === 1 ? 'e2e4' : 'e7e5'; } };
    await runMatch('m1', { maxPlies: 1000 }, deps(repo, { getAdapter: () => adapter }));
    expect(moves).toBe(2);
    expect(repo.events[repo.events.length - 1].type).toBe('MATCH_CANCELLED');
    expect(repo.statusLog.map(s => s.status)).not.toContain(MatchStatus.COMPLETED);
    expect(repo.status).toBe(MatchStatus.CANCELLED);
    expect(repo.leaseOwner).toBeNull();
  });

  it('never starts a match that was cancelled while queued', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']), MatchStatus.CANCELLED);
    const result = await runMatchSlice('m1', {}, deps(repo));
    expect(result).toEqual({ done: true, status: 'finished' });
    expect(repo.events).toHaveLength(0);
    expect(repo.statusLog).toHaveLength(0);
  });

  it('a finish that races with a cancel does not overwrite CANCELLED', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    const original = repo.recordMove.bind(repo);
    repo.recordMove = async (id, move, events) => { await original(id, move, events); if (events.some(e => e.type === 'RESULT')) repo.cancel(); };
    await runMatch('m1', {}, deps(repo));
    expect(repo.status).toBe(MatchStatus.CANCELLED);
  });
});

describe('slices', () => {
  /** A clock the test advances: every model call takes `callMs`. */
  const fake = (callMs: number) => {
    const clock = { t: 1_000_000 };
    return {
      clock,
      now: () => clock.t,
      adapter: (): ModelAdapter => {
        const inner = scriptedAdapter();
        return { generateMove: async (p, h, r, o) => { clock.t += callMs; return inner.generateMove(p, h, r, o); } };
      }
    };
  };

  it('yields when the next call would not fit in the slice, then the next slice continues', async () => {
    const f = fake(20_000);
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'), MatchStatus.PENDING, f.now);
    const d = deps(repo, { getAdapter: f.adapter, now: f.now, moveTimeoutMs: 60_000 });

    // Deadline 130s ahead: calls may start while at least 60s remain, so at t=0,20,40,60 => 4 moves, then yield.
    const first = await runMatchSlice('m1', { maxPlies: 30 }, d, { deadlineAt: f.now() + 130_000 });
    expect(first).toEqual({ done: false, status: 'yielded' });
    expect(repo.moves).toHaveLength(4);
    expect(repo.status).toBe(MatchStatus.RUNNING);
    expect(repo.leaseOwner).toBeNull();

    let slices = 1;
    let last: SliceResult = first;
    while (!last.done && slices < 50) {
      last = await runMatchSlice('m1', { maxPlies: 30 }, d, { deadlineAt: f.now() + 130_000 });
      slices++;
    }
    expect(last.status).toBe('completed');
    expect(repo.moves).toHaveLength(30);
    expect(slices).toBe(Math.ceil(30 / 4));
    expect(repo.sliceCount).toBe(slices);
  });

  it('automatic and system moves never force a yield (no model call needed)', async () => {
    const f = fake(20_000);
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1'], 'openai'), MatchStatus.PENDING, f.now);
    const result = await runMatchSlice('m1', {}, deps(repo, { getAdapter: f.adapter, now: f.now }), { deadlineAt: f.now() + 1_000 });
    expect(result.status).toBe('completed');
  });

  it('is exactly equivalent to an uninterrupted run, for every engine and many seeds', async () => {
    const cases: Array<{ game: string; roles: string[]; options: any }> = [
      { game: 'chess', roles: ['white', 'black'], options: { maxPlies: 60 } },
      { game: 'texas_holdem', roles: ['seat1', 'seat2', 'seat3', 'seat4'], options: { playerCount: 4 } },
      { game: 'blackjack', roles: ['seat1', 'seat2', 'seat3'], options: { playerCount: 3, allowSplit: true } },
      { game: 'chutes_and_ladders', roles: ['player1'], options: {} }
    ];
    for (const { game, roles, options } of cases) {
      for (let seed = 1; seed <= 12; seed++) {
        const reference = new MemoryRepo(mkMatch(game, roles, 'openai', { seed }));
        await runMatch('m1', options, deps(reference, { getAdapter: scriptedAdapter }));

        for (const perSlice of [1, 2, 3, 7]) {
          const f = fake(10_000);
          const sliced = new MemoryRepo(mkMatch(game, roles, 'openai', { seed }), MatchStatus.PENDING, f.now);
          const d = deps(sliced, { getAdapter: f.adapter, now: f.now, moveTimeoutMs: 10_000 });
          let result: SliceResult = { done: false, status: 'yielded' };
          let guard = 0;
          while (!result.done && guard++ < 500) {
            // allow exactly `perSlice` model calls per slice
            result = await runMatchSlice('m1', options, d, { deadlineAt: f.now() + 10_000 * perSlice });
          }
          expect(result.status).toBe('completed');
          expect(JSON.stringify(sliced.events)).toBe(JSON.stringify(reference.events));
          expect(sliced.scores).toEqual(reference.scores);
          expect(sliced.moves).toEqual(reference.moves);
        }
      }
    }
  }, 120000);

  it('survives a crash after a move was recorded: the next slice resumes with no gap or duplicate', async () => {
    const options = { maxPlies: 30 };
    const reference = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    await runMatch('m1', options, deps(reference, { getAdapter: scriptedAdapter }));

    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    const original = repo.recordMove.bind(repo);
    let recorded = 0;
    repo.recordMove = async (id, move, events) => {
      await original(id, move, events);
      if (++recorded === 5) throw new Error('process died right after persisting move 5');
    };
    await expect(runMatchSlice('m1', options, deps(repo, { getAdapter: scriptedAdapter }))).rejects.toThrow(/process died/);
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(repo.moves).toHaveLength(5);

    repo.recordMove = original;
    const resumed = await runMatchSlice('m1', options, deps(repo, { getAdapter: scriptedAdapter }), { resumeFailed: true });
    expect(resumed.status).toBe('completed');
    expect(JSON.stringify(repo.events)).toBe(JSON.stringify(reference.events));
    expect(repo.events.map(e => e.seq)).toEqual(repo.events.map((_, i) => i));
  });

  it('only one runner at a time: a second slice sees the lease and does nothing', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const slow: ModelAdapter = { generateMove: async () => { calls++; await gate; return 'e2e4'; } };
    const first = runMatchSlice('m1', { maxPlies: 2 }, deps(repo, { getAdapter: () => slow }), { owner: 'A' });
    await new Promise(resolve => setImmediate(resolve));
    const second = await runMatchSlice('m1', { maxPlies: 2 }, deps(repo, { getAdapter: () => slow }), { owner: 'B' });
    expect(second).toEqual({ done: false, status: 'busy' });
    expect(calls).toBe(1);
    release();
    await first;
    expect(repo.moves.length).toBeGreaterThan(0);
    expect(new Set(repo.moves.map(m => m.move_index)).size).toBe(repo.moves.length);
  });

  it('an expired lease can be taken over by a new runner', async () => {
    const clock = { t: 5_000_000 };
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']), MatchStatus.RUNNING, () => clock.t);
    repo.leaseOwner = 'dead-runner';
    repo.leaseExpiresAt = clock.t + 1000;
    expect(await runMatchSlice('m1', {}, deps(repo), { owner: 'new' })).toEqual({ done: false, status: 'busy' });
    clock.t += 5_000;
    expect((await runMatchSlice('m1', {}, deps(repo, { now: () => clock.t }), { owner: 'new' })).status).toBe('completed');
  });

  it('a runner that loses its lease stops without writing or changing the status', async () => {
    const repo = new MemoryRepo(mkMatch('texas_holdem', ['seat1', 'seat2'], 'openai'));
    let calls = 0;
    const adapter: ModelAdapter = { generateMove: async () => { calls++; if (calls === 1) repo.stealLease(); return 'CALL'; } };
    const result = await runMatchSlice('m1', { playerCount: 2 }, deps(repo, { getAdapter: () => adapter }));
    expect(result.status).toBe('lost');
    expect(repo.status).toBe(MatchStatus.RUNNING);
    expect(repo.moves.length).toBeLessThanOrEqual(1);
    expect(repo.leaseOwner).toBe('someone-else');
  });

  it('a duplicate move write is treated as a lost lease, not a failure', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    repo.recordMove = async () => { throw new LeaseLostError(); }; // another runner already recorded this move index
    const result = await runMatchSlice('m1', {}, deps(repo));
    expect(result.status).toBe('lost');
    expect(repo.status).not.toBe(MatchStatus.FAILED);
  });

  it('detects a non-deterministic engine instead of silently corrupting the match', async () => {
    // A previous slice persisted: 1 start event + 2 moves of 1 event each. This engine now emits 2 events per move on replay.
    const engine = async (): Promise<GameEngine> => ({
      gameType: 'flaky',
      initialize: () => [{ turn: 0, actor: 'system', type: 'S', payload: {} }],
      processMove: (h: GameEvent[]) => ({
        events: [{ turn: h.length, actor: 'system', type: 'M', payload: {} }, { turn: h.length, actor: 'system', type: 'M2', payload: {} }],
        result: null
      }),
      getSystemPrompt: () => 'p',
      getRandomMove: (_h: GameEvent[], role: string) => ({ actor: role, content: 'x' })
    });
    const repo = new MemoryRepo(mkMatch('flaky', ['player1']), MatchStatus.RUNNING);
    repo.moves = [{ move_index: 0, actor_role: 'player1', content: 'x' }, { move_index: 1, actor_role: 'player1', content: 'x' }];
    repo.events = [0, 1, 2].map(seq => ({ turn_index: seq, seq, type: 'X', actor_role: 'system', payload: {} }));
    await expect(runMatchSlice('m1', {}, deps(repo, { getEngine: engine }))).rejects.toThrow(/not deterministic/);
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(repo.events).toHaveLength(3); // nothing was written on top of the inconsistent state
  });

  it('retry budget restarts when a failed match is resumed', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'openai'));
    repo.moveFailures = 3;
    repo.status = MatchStatus.FAILED;
    const adapter: ModelAdapter = { generateMove: async (_p, h, r) => scriptedAdapter().generateMove('', h, r) };
    const result = await runMatchSlice('m1', { maxPlies: 4 }, deps(repo, { getAdapter: () => adapter }), { resumeFailed: true });
    expect(result.status).toBe('completed');
    expect(repo.moveFailures).toBe(0);
  });
});
