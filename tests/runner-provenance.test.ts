/** What the runner records with every move (docs/INTEGRITY_SPEC.md, `provenance`). */
import { createHash } from 'crypto';
import { MatchStatus } from '@prisma/client';
import { runMatch, runMatchSlice, RunnerDeps, RunnerMatch } from '../src/services/match-runner.service';
import { getModelAdapter } from '../src/game/adapters';
import { getGameEngine } from '../src/game/registry';
import { CallMeta, ModelAdapter, PROVIDER_DEFAULT, UNKNOWN } from '../src/game/types';
import { MoveProvenance } from '../src/integrity/provenance';
import { MAX_RAW_BYTES } from '../src/integrity/raw-response';
import { PriceTable } from '../src/integrity/pricing';
import { MemoryRepo } from './helpers/memory-repo';
import { scriptedAdapter } from './helpers/scripted-adapter';

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn() } } }));

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const mkMatch = (game_type: string, roles: string[], provider = 'openai', model = 'model-x'): RunnerMatch => ({
  id: 'm1', game_type, seed: 99, participants: roles.map((role, i) => ({ id: `p${i + 1}`, role, model: { api_provider: provider, api_model_id: model } }))
});
const deps = (repo: MemoryRepo, extra: Partial<RunnerDeps> = {}): RunnerDeps => ({
  repo, getEngine: getGameEngine, getAdapter: getModelAdapter, maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra
});
const prov = (repo: MemoryRepo): MoveProvenance[] => repo.moves.map(m => m.provenance as MoveProvenance);

/** An adapter that reports what a real one would. */
const reportingAdapter = (): ModelAdapter => {
  const inner = scriptedAdapter();
  const meta: CallMeta = { adapter: 'anthropic', model_reported: 'model-x-20260101', sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT } };
  return { generateMove: inner.generateMove, generateMoveWithMeta: async (...a) => ({ text: await inner.generateMove(...a), meta }) };
};

const noBlanks = (v: unknown): boolean =>
  v === undefined ? false : typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) ? v.every(noBlanks) : v && typeof v === 'object' ? Object.values(v).every(noBlanks) : true;

describe('provenance recorded with each move', () => {
  it('a model move records the prompt, the model requested and reported, and the sampling used', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 6 }, deps(repo, { getAdapter: reportingAdapter }));
    const engine = await getGameEngine('chess');
    const modelMoves = prov(repo).filter(p => p.source === 'model');
    expect(modelMoves.length).toBeGreaterThanOrEqual(6);
    expect(modelMoves[0]).toMatchObject({
      v: 1, source: 'model', adapter: 'anthropic',
      prompt: { id: 'chess/white', version: '1.1.0', sha256: sha256(engine.getSystemPrompt('white')) },
      model: { provider: 'openai', requested: 'model-x', reported: 'model-x-20260101' },
      sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT }
    });
    expect(modelMoves[1].prompt!.id).toBe('chess/black');
    expect(modelMoves[0].prompt!.sha256).not.toBe(modelMoves[1].prompt!.sha256); // each role has its own prompt
  });

  it('an adapter that cannot report is recorded as explicit unknowns, never blank', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 4 }, deps(repo, { getAdapter: scriptedAdapter })); // scriptedAdapter has no generateMoveWithMeta
    const first = prov(repo)[0];
    expect(first.model).toEqual({ provider: 'openai', requested: 'model-x', reported: UNKNOWN });
    expect(first.sampling).toEqual({ temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN });
    expect(first.adapter).toBe(UNKNOWN);
    expect(first.response).toBe(UNKNOWN); // no raw response was available, and the record says so
    expect(first.usage!.source).toBe('estimated'); // no provider counts, so ours are used and labelled
    expect(first.prompt!.version).toBe('1.1.0'); // what the engine declared is still known
  });

  it('every move of every match has provenance, and none of it contains a blank', async () => {
    for (const [game, roles, options] of [['chess', ['white', 'black'], { maxPlies: 10 }], ['texas_holdem', ['seat1', 'seat2', 'seat3'], { playerCount: 3 }], ['blackjack', ['seat1', 'seat2'], { playerCount: 2 }], ['chutes_and_ladders', ['player1'], {}]] as Array<[string, string[], any]>) {
      const repo = new MemoryRepo(mkMatch(game, roles));
      await runMatch('m1', options, deps(repo, { getAdapter: reportingAdapter }));
      expect(repo.moves.length).toBeGreaterThan(0);
      for (const m of repo.moves) {
        expect({ game, index: m.move_index, recorded: m.provenance != null }).toEqual({ game, index: m.move_index, recorded: true });
        expect({ game, index: m.move_index, noBlanks: noBlanks(m.provenance) }).toEqual({ game, index: m.move_index, noBlanks: true });
      }
    }
  });

  it('moves the engine makes itself (dice, resolve steps) say so and involve no model', async () => {
    const repo = new MemoryRepo(mkMatch('chutes_and_ladders', ['player1']));
    await runMatch('m1', {}, deps(repo, { getAdapter: reportingAdapter }));
    expect(prov(repo).every(p => p.source === 'engine' && p.model === null && p.prompt === null && p.sampling === null)).toBe(true);
  });

  it('the mock model is recorded as a seeded random player, with no prompt', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black'], 'mock', 'mock-random'));
    await runMatch('m1', { maxPlies: 4 }, deps(repo));
    for (const p of prov(repo)) {
      expect(p).toEqual({ v: 1, source: 'random', prompt: null, model: { provider: 'mock', requested: 'mock-random', reported: 'mock' }, sampling: null, adapter: 'seeded-random', usage: null, latency_ms: null, cost: null, response: null });
    }
  });

  it('a prompt that changes between games changes the recorded hash', async () => {
    const a = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    const b = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    const engine = await getGameEngine('chess');
    const original = engine.getSystemPrompt.bind(engine);
    await runMatch('m1', { maxPlies: 2 }, deps(a, { getAdapter: reportingAdapter }));
    await runMatch('m1', { maxPlies: 2 }, deps(b, { getAdapter: reportingAdapter, getEngine: async (g, id) => { const e = await getGameEngine(g, id); e.getSystemPrompt = (r: string) => original(r) + ' Be concise.'; return e; } }));
    expect(prov(a)[0].prompt!.sha256).not.toBe(prov(b)[0].prompt!.sha256);
    expect(prov(a)[0].prompt!.id).toBe(prov(b)[0].prompt!.id);
  });

  it('slicing a match across many runners records exactly what an uninterrupted match records, and never rewrites a stored move', async () => {
    const reference = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 24 }, deps(reference, { getAdapter: reportingAdapter }));

    let t = 1_000_000;
    const timed = (): ModelAdapter => { const inner = reportingAdapter(); return { generateMove: inner.generateMove, generateMoveWithMeta: async (...a) => { t += 10_000; return inner.generateMoveWithMeta!(...a); } }; };
    const sliced = new MemoryRepo(mkMatch('chess', ['white', 'black']), MatchStatus.PENDING, () => t);
    let result = { done: false, status: 'yielded' } as { done: boolean; status: string };
    const seen: string[] = [];
    for (let i = 0; !result.done && i < 100; i++) {
      result = await runMatchSlice('m1', { maxPlies: 24 }, deps(sliced, { getAdapter: timed, now: () => t, moveTimeoutMs: 10_000 }), { deadlineAt: t + 20_000 });
      // everything stored by earlier slices is exactly as it was written
      seen.forEach((json, idx) => expect(JSON.stringify(sliced.moves[idx])).toBe(json));
      sliced.moves.forEach((m, idx) => { seen[idx] = JSON.stringify(m); });
    }
    expect(result.status).toBe('completed');
    // everything but the measured latency (wall-clock time differs between two runs by nature) must be identical
    const withoutLatency = (moves: typeof reference.moves) => moves.map(m => ({ ...m, provenance: { ...(m.provenance as object), latency_ms: 0 } }));
    expect(withoutLatency(sliced.moves)).toEqual(withoutLatency(reference.moves));
  });
});

describe('tokens, latency, cost and the raw response, per move', () => {
  const PRICES: PriceTable = { version: '2026-11-01', models: [{ provider: 'openai', model_prefix: 'model-x', input_per_mtok: 2, output_per_mtok: 8 }] };
  /** An adapter whose provider reports usage and returns a body, like the real ones. */
  const rawAdapter = (body: (n: number) => unknown, usage = { input_tokens: 1000, output_tokens: 50 }): (() => ModelAdapter) => () => {
    const inner = scriptedAdapter();
    let n = 0;
    return {
      generateMove: inner.generateMove,
      generateMoveWithMeta: async (...a) => ({
        text: await inner.generateMove(...a),
        meta: { adapter: 'openai-compatible', model_reported: 'model-x-1', sampling: { temperature: 0, max_tokens: PROVIDER_DEFAULT, top_p: PROVIDER_DEFAULT }, usage },
        raw: body(n++)
      })
    };
  };

  it('a model move records provider tokens, latency, a computed cost and the digest of the stored raw response', async () => {
    let t = 1_000_000;
    const adapter = rawAdapter(n => ({ id: `resp-${n}`, usage: { prompt_tokens: 1000, completion_tokens: 50 } }));
    const timed = (): ModelAdapter => { const inner = adapter(); return { generateMove: inner.generateMove, generateMoveWithMeta: async (...a) => { t += 1234; return inner.generateMoveWithMeta!(...a); } }; };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']), MatchStatus.PENDING, () => t);
    await runMatch('m1', { maxPlies: 4 }, deps(repo, { getAdapter: timed, now: () => t, prices: PRICES }));

    const first = prov(repo)[0];
    expect(first.usage).toEqual({ input_tokens: 1000, output_tokens: 50, source: 'provider' });
    expect(first.latency_ms).toBe(1234);
    expect(first.cost).toEqual({ usd: 0.0024, basis: 'provider-usage', pricing: { input_per_mtok: 2, output_per_mtok: 8, table_version: '2026-11-01' } });

    const stored = repo.rawResponses.find(r => r.move_index === 0)!;
    expect(JSON.parse(stored.text)).toEqual({ id: 'resp-0', usage: { prompt_tokens: 1000, completion_tokens: 50 } });
    expect(first.response).toEqual({ sha256: stored.sha256, bytes: stored.bytes, truncated: false });
    expect(createHash('sha256').update(stored.text, 'utf8').digest('hex')).toBe(stored.sha256);
  });

  it('every model move has a raw response stored and a matching digest; engine and random moves have none', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 6 }, deps(repo, { getAdapter: rawAdapter(n => ({ n })) }));
    const modelIndexes = repo.moves.filter((_, i) => prov(repo)[i].source === 'model').map(m => m.move_index);
    expect(repo.rawResponses.map(r => r.move_index)).toEqual(modelIndexes);
    for (const m of repo.moves) {
      const p = m.provenance as MoveProvenance;
      const raw = repo.rawResponses.find(r => r.move_index === m.move_index);
      if (p.source === 'model') expect(p.response).toEqual({ sha256: raw!.sha256, bytes: raw!.bytes, truncated: false });
      else { expect(raw).toBeUndefined(); expect(p.response).toBeNull(); expect(p.usage).toBeNull(); expect(p.latency_ms).toBeNull(); expect(p.cost).toBeNull(); }
    }
  });

  it('without a price for the model the cost is recorded as unknown, not zero', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 2 }, deps(repo, { getAdapter: rawAdapter(() => ({})) })); // the shipped price list is empty
    expect(prov(repo)[0].cost).toEqual({ usd: UNKNOWN, basis: UNKNOWN, pricing: UNKNOWN });
  });

  it('an oversized response is stored cut at the size limit with a truncation marker, and the digest covers the whole', async () => {
    const big = { text: 'x'.repeat(MAX_RAW_BYTES * 3) };
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    await runMatch('m1', { maxPlies: 2 }, deps(repo, { getAdapter: rawAdapter(() => big) }));
    const stored = repo.rawResponses[0];
    expect(stored.truncated).toBe(true);
    expect(Buffer.byteLength(stored.text, 'utf8')).toBeLessThanOrEqual(MAX_RAW_BYTES);
    expect(stored.bytes).toBe(Buffer.byteLength(JSON.stringify(big), 'utf8'));
    expect(stored.sha256).toBe(createHash('sha256').update(JSON.stringify(big), 'utf8').digest('hex'));
    expect(prov(repo)[0].response).toEqual({ sha256: stored.sha256, bytes: stored.bytes, truncated: true });
  });

  it('credentials in a response body never reach storage', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    const leaky = () => ({ id: 'r', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuv', 'x-api-key': 'k' }, echo: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', content: 'e2e4' });
    await runMatch('m1', { maxPlies: 2 }, deps(repo, { getAdapter: rawAdapter(leaky) }));
    const text = repo.rawResponses.map(r => r.text).join('\n');
    expect(text).not.toMatch(/abcdefghijklmnopqrstuv|sk-ant|"k"/);
    expect(text).toContain('[redacted]');
    expect(prov(repo).every(p => p.source !== 'model' || (p.response as any).sha256)).toBe(true);
  });

  it('a move that loses the race writes no raw response either (it is part of the same record)', async () => {
    const repo = new MemoryRepo(mkMatch('chess', ['white', 'black']));
    const original = repo.recordMove.bind(repo);
    let calls = 0;
    repo.recordMove = async (id, move, events) => { if (++calls === 3) { const { LeaseLostError } = await import('../src/repositories/match.repository'); throw new LeaseLostError(); } return original(id, move, events); };
    await runMatchSlice('m1', { maxPlies: 10 }, deps(repo, { getAdapter: rawAdapter(n => ({ n })) }));
    expect(repo.moves).toHaveLength(2);
    expect(repo.rawResponses).toHaveLength(2);
  });
});
