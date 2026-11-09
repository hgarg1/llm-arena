/**
 * The runner's event log is hash-chained as it is written (docs/INTEGRITY_SPEC.md). Every chain produced here is
 * checked with the independent reference verifier, not with the code that wrote it.
 */
import { MatchStatus } from '@prisma/client';
import { runMatch, runMatchSlice, RunnerDeps, RunnerMatch, SliceResult } from '../src/services/match-runner.service';
import { getModelAdapter } from '../src/game/adapters';
import { getGameEngine } from '../src/game/registry';
import { ModelAdapter } from '../src/game/types';
import { MemoryRepo, StoredEvent, participants } from './helpers/memory-repo';
import { scriptedAdapter } from './helpers/scripted-adapter';
import { Envelope, EventRecord, SPEC, chain, genesisHash, keyId, publicKeyRawFromSeed, signManifest, verifyMatch } from './helpers/integrity-reference';

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn() } } }));

const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const KEYS = [{ key_id: keyId(publicKeyRawFromSeed(SEED)), alg: 'Ed25519' as const, public_key: publicKeyRawFromSeed(SEED).toString('base64url'), status: 'active' as const }];

const mkMatch = (game_type: string, roles: string[], over: Partial<RunnerMatch> = {}): RunnerMatch =>
  ({ id: 'm1', game_type, seed: 99, participants: participants('openai', roles), ...over });

const deps = (repo: MemoryRepo, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  repo, getEngine: getGameEngine, getAdapter: getModelAdapter, maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra
});

const CASES: Array<{ game: string; roles: string[]; options: any }> = [
  { game: 'chess', roles: ['white', 'black'], options: { maxPlies: 40 } },
  { game: 'texas_holdem', roles: ['seat1', 'seat2', 'seat3'], options: { playerCount: 3 } },
  { game: 'blackjack', roles: ['seat1', 'seat2'], options: { playerCount: 2 } },
  { game: 'chutes_and_ladders', roles: ['player1'], options: {} }
];

const records = (events: StoredEvent[]): EventRecord[] =>
  events.map(e => ({ seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload }));

/** What a verifier would receive: the stored events plus a manifest signed over their head. */
const envelopeFor = (matchId: string, events: StoredEvent[]): Envelope =>
  signManifest({
    spec: SPEC, key_id: KEYS[0].key_id, match_id: matchId, game_type: 'x', ruleset_version: '1', seed: 1, status: 'COMPLETED',
    events: { count: events.length, head_hash: chain(matchId, records(events)).head }, started_at: null, finished_at: null
  }, SEED);

const play = async (c: (typeof CASES)[number], seed = 99) => {
  const repo = new MemoryRepo(mkMatch(c.game, c.roles, { seed }));
  await runMatch('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }));
  return repo;
};

describe('hash chain written by the runner', () => {
  it.each(CASES)('$game: every event is chained, and the independent verifier accepts the log', async c => {
    const repo = await play(c);
    expect(repo.status).toBe(MatchStatus.COMPLETED);
    expect(repo.events.length).toBeGreaterThan(1);

    const ref = chain('m1', records(repo.events));
    expect(repo.events.map(e => e.hash)).toEqual(ref.hashes);
    expect(repo.events[0].prev_hash).toBe(genesisHash('m1'));
    repo.events.slice(1).forEach((e, i) => expect(e.prev_hash).toBe(repo.events[i].hash));
    expect(verifyMatch('m1', records(repo.events), envelopeFor('m1', repo.events), KEYS)).toEqual({ result: 'VERIFIED' });
  });

  it('the same match under a different match id has a different chain (the id is bound in)', async () => {
    const a = await play(CASES[0]);
    const other = new MemoryRepo(mkMatch('chess', ['white', 'black'], { id: 'm2', seed: 99 }));
    await runMatch('m2', CASES[0].options, deps(other, { getAdapter: scriptedAdapter }));
    expect(other.events.map(e => e.type)).toEqual(a.events.map(e => e.type));
    expect(other.events[0].hash).not.toBe(a.events[0].hash);
  });

  it('editing, removing, reordering or appending any stored event fails verification', async () => {
    const repo = await play(CASES[1]);
    const envelope = envelopeFor('m1', repo.events);
    const good = records(repo.events);
    const outcome = (events: EventRecord[]) => verifyMatch('m1', events, envelope, KEYS);

    expect(outcome(good)).toEqual({ result: 'VERIFIED' });
    for (let i = 0; i < good.length; i++) {
      const edited = good.map((e, j) => (j === i ? { ...e, payload: { tampered: true } } : e));
      expect(outcome(edited)).toEqual({ result: 'FAILED', code: 'HEAD_MISMATCH' });
      expect(outcome(good.filter((_, j) => j !== i))).toMatchObject({ result: 'FAILED' });
    }
    const swapped = good.map(e => ({ ...e }));
    [swapped[1].payload, swapped[2].payload] = [swapped[2].payload, swapped[1].payload];
    expect(outcome(swapped)).toEqual({ result: 'FAILED', code: 'HEAD_MISMATCH' });
    expect(outcome([...good, { seq: good.length, turn_index: 99, type: 'EXTRA', actor_role: 'system', payload: {} }])).toEqual({ result: 'FAILED', code: 'EVENT_COUNT_MISMATCH' });
  });
});

describe('resuming a match keeps one unbroken chain', () => {
  const fake = (callMs: number) => {
    const clock = { t: 1_000_000 };
    return {
      now: () => clock.t,
      adapter: (): ModelAdapter => {
        const inner = scriptedAdapter();
        return { generateMove: async (p, h, r, o) => { clock.t += callMs; return inner.generateMove(p, h, r, o); } };
      }
    };
  };

  it.each(CASES)('$game: slices of every size give exactly the uninterrupted chain', async c => {
    const reference = await play(c);
    for (const perSlice of [1, 2, 5]) {
      const f = fake(10_000);
      const sliced = new MemoryRepo(mkMatch(c.game, c.roles), MatchStatus.PENDING, f.now);
      const d = deps(sliced, { getAdapter: f.adapter, now: f.now, moveTimeoutMs: 10_000 });
      let result: SliceResult = { done: false, status: 'yielded' };
      for (let guard = 0; !result.done && guard < 500; guard++) result = await runMatchSlice('m1', c.options, d, { deadlineAt: f.now() + 10_000 * perSlice });
      expect(result.status).toBe('completed');
      expect(sliced.events.map(e => [e.hash, e.prev_hash])).toEqual(reference.events.map(e => [e.hash, e.prev_hash]));
      expect(verifyMatch('m1', records(sliced.events), envelopeFor('m1', sliced.events), KEYS)).toEqual({ result: 'VERIFIED' });
    }
  });

  it('a runner that dies right after persisting a move, at any point, is resumed to the same chain', async () => {
    const c = CASES[0];
    const reference = await play(c);
    const moves = reference.moves.length;
    for (const dieAfter of [1, 2, 7, moves - 1]) {
      const repo = new MemoryRepo(mkMatch(c.game, c.roles));
      const original = repo.recordMove.bind(repo);
      let recorded = 0;
      repo.recordMove = async (id, move, events) => {
        await original(id, move, events);
        if (++recorded === dieAfter) throw new Error('process died after persisting the move');
      };
      await expect(runMatchSlice('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }))).rejects.toThrow(/process died/);
      expect(repo.moves).toHaveLength(dieAfter);

      repo.recordMove = original; // a different runner picks the match up
      const resumed = await runMatchSlice('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }), { resumeFailed: true, owner: 'runner-2' });
      expect(resumed.status).toBe('completed');
      expect(repo.events.map(e => e.hash)).toEqual(reference.events.map(e => e.hash));
      expect(verifyMatch('m1', records(repo.events), envelopeFor('m1', repo.events), KEYS)).toEqual({ result: 'VERIFIED' });
    }
  });

  it('a duplicate write from a runner that lost its lease changes nothing', async () => {
    const c = CASES[0];
    const repo = new MemoryRepo(mkMatch(c.game, c.roles));
    await runMatchSlice('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }), { owner: 'A' });
    const before = JSON.stringify(repo.events);
    // runner B replays the same move index: rejected, and the log is untouched
    await expect(repo.recordMove('m1', { index: 0, actor: 'white', content: 'x' }, [{ turn_index: 1, seq: repo.events.length, type: 'X', actor_role: 'white', payload: {} }])).rejects.toThrow();
    expect(JSON.stringify(repo.events)).toBe(before);
  });
});

describe('matches that started before chaining existed', () => {
  it('stay unchained to the end: no hashes are invented partway through', async () => {
    const c = CASES[0];
    const reference = await play(c);

    const repo = new MemoryRepo(mkMatch(c.game, c.roles));
    let recorded = 0;
    const original = repo.recordMove.bind(repo);
    repo.recordMove = async (id, move, events) => { await original(id, move, events); if (++recorded === 6) throw new Error('deployed mid-match'); };
    await expect(runMatchSlice('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }))).rejects.toThrow(/deployed mid-match/);

    // rewrite what is stored so far the way old rows look: no hashes
    repo.events = repo.events.map(e => ({ ...e, hash: null, prev_hash: null }));
    repo.recordMove = original;
    const resumed = await runMatchSlice('m1', c.options, deps(repo, { getAdapter: scriptedAdapter }), { resumeFailed: true });

    expect(resumed.status).toBe('completed');
    expect(repo.events.map(e => [e.hash, e.prev_hash])).toEqual(repo.events.map(() => [null, null]));
    expect(repo.events.map(e => ({ seq: e.seq, type: e.type, payload: e.payload }))).toEqual(reference.events.map(e => ({ seq: e.seq, type: e.type, payload: e.payload })));
  });
});
