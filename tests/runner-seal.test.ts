/** When the runner asks for a match to be sealed (signed): at the end of every slice, whatever state it ended in. */
import { MatchStatus } from '@prisma/client';
import { runMatchSlice, RunnerDeps, RunnerMatch } from '../src/services/match-runner.service';
import { getModelAdapter } from '../src/game/adapters';
import { getGameEngine } from '../src/game/registry';
import { ModelAdapter } from '../src/game/types';
import { MemoryRepo, participants } from './helpers/memory-repo';
import { scriptedAdapter } from './helpers/scripted-adapter';

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn() } } }));

const mkMatch = (game_type: string, roles: string[]): RunnerMatch => ({ id: 'm1', game_type, seed: 99, participants: participants('openai', roles) });
const deps = (repo: MemoryRepo, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  repo, getEngine: getGameEngine, getAdapter: getModelAdapter, maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra
});

describe('the runner asks for the match to be sealed', () => {
  it('after a completed match, once the lease is released', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    let leaseWhenSealed: string | null = 'unset';
    const original = repo.sealIfFinal.bind(repo);
    repo.sealIfFinal = async () => { leaseWhenSealed = repo.leaseOwner; await original(); };
    await runMatchSlice('m1', {}, deps(repo, { getAdapter: scriptedAdapter }));
    expect(repo.status).toBe(MatchStatus.COMPLETED);
    expect(repo.sealCalls).toEqual([MatchStatus.COMPLETED]);
    expect(leaseWhenSealed).toBeNull(); // nobody can still be writing when the manifest is signed
  });

  it('after a failed match', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    const broken: ModelAdapter = { generateMove: async () => { throw new Error('provider down'); } };
    await expect(runMatchSlice('m1', { maxPlies: 4 }, deps(repo, { getAdapter: () => broken, moveAttempts: 1, backoffMs: 0 }))).rejects.toThrow();
    expect(repo.status).toBe(MatchStatus.FAILED);
    expect(repo.sealCalls[repo.sealCalls.length - 1]).toBe(MatchStatus.FAILED);
  });

  it('after a cancelled match, when the runner notices and stops', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    let calls = 0;
    const adapter: ModelAdapter = { generateMove: async () => { if (++calls === 2) repo.cancel(); return 'e2e4'; } };
    await runMatchSlice('m1', { maxPlies: 40 }, deps(repo, { getAdapter: () => adapter }));
    expect(repo.status).toBe(MatchStatus.CANCELLED);
    expect(repo.sealCalls[repo.sealCalls.length - 1]).toBe(MatchStatus.CANCELLED);
  });

  it('after every slice, but only a final state is ever signed (the others are no-ops for the repository)', async () => {
    let t = 1_000_000;
    const adapter = (): ModelAdapter => { const inner = scriptedAdapter(); return { generateMove: async (...a) => { t += 10_000; return inner.generateMove(...a); } }; };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']), MatchStatus.PENDING, () => t);
    let slices = 0;
    let result = { done: false, status: 'yielded' } as { done: boolean; status: string };
    while (!result.done && slices < 100) {
      result = await runMatchSlice('m1', { maxPlies: 10 }, deps(repo, { getAdapter: adapter, now: () => t, moveTimeoutMs: 10_000 }), { deadlineAt: t + 20_000 });
      slices++;
    }
    expect(slices).toBeGreaterThan(2);
    expect(repo.sealCalls).toHaveLength(slices);
    expect(repo.sealCalls.slice(0, -1).every(s => s === MatchStatus.RUNNING)).toBe(true);
    expect(repo.sealCalls[slices - 1]).toBe(MatchStatus.COMPLETED);
  });

  it('a slice that finds the match busy does nothing: the runner holding the lease is the one that seals', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']), MatchStatus.RUNNING);
    repo.stealLease();
    const result = await runMatchSlice('m1', { maxPlies: 4 }, deps(repo, { getAdapter: scriptedAdapter }));
    expect(result.status).toBe('busy');
    expect(repo.sealCalls).toEqual([]);
  });

  it('a failing seal never breaks the slice; it is logged and left for the sweeper', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    repo.sealIfFinal = async () => { throw new Error('kms unreachable'); };
    const log = jest.fn();
    const result = await runMatchSlice('m1', {}, deps(repo, { getAdapter: scriptedAdapter, log }));
    expect(result.status).toBe('completed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('kms unreachable'));
  });
});
