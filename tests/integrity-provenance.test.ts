/** Per-move provenance: what is recorded for each kind of move, and the rule that no field is ever blank. */
import { createHash } from 'crypto';
import { CallMeta, UNKNOWN, PROVIDER_DEFAULT } from '../src/game/types';
import { engineProvenance, modelProvenance, promptIdentity, randomProvenance, tokenUsage } from '../src/integrity/provenance';
import { PriceTable } from '../src/integrity/pricing';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Every value is a real value, one of the markers, or an explicit null for a part that does not apply. Never '' or undefined. */
const assertNoBlanks = (value: unknown, path = 'provenance') => {
  expect(value).not.toBeUndefined();
  if (typeof value === 'string') expect({ path, blank: value.trim() === '' }).toEqual({ path, blank: false });
  else if (Array.isArray(value)) value.forEach((v, i) => assertNoBlanks(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoBlanks(v, `${path}.${k}`);
};

const PRICES: PriceTable = { version: '2026-11-01', models: [{ provider: 'anthropic', model_prefix: 'claude-x', input_per_mtok: 3, output_per_mtok: 15 }] };
const DIGEST = { sha256: 'a'.repeat(64), bytes: 120, truncated: false };
const EXTRA = { usage: { input_tokens: 1000, output_tokens: 200, source: 'provider' as const }, latencyMs: 850, response: DIGEST, prices: PRICES };

const META: CallMeta = { adapter: 'anthropic', model_reported: 'claude-x-20260101', sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT } };

describe('promptIdentity', () => {
  it('names the template by game and role and hashes the exact prompt text', () => {
    expect(promptIdentity('chess', 'white', 'You play white.', '1.1.0')).toEqual({ id: 'chess/white', version: '1.1.0', sha256: sha256('You play white.') });
  });
  it('a changed prompt changes the hash, and a missing ruleset version is `unknown`, not blank', () => {
    expect(promptIdentity('chess', 'white', 'You play white!', '1.1.0').sha256).not.toBe(promptIdentity('chess', 'white', 'You play white.', '1.1.0').sha256);
    for (const missing of [undefined, null, '', '   ', 42]) expect(promptIdentity('g', 'r', 'p', missing).version).toBe(UNKNOWN);
  });
});

describe('modelProvenance', () => {
  const prompt = promptIdentity('chess', 'white', 'sys', '1.1.0');

  it('records provider, requested and reported model, sampling and adapter for a model move', () => {
    const p = modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META, ...EXTRA });
    expect(p).toEqual({
      v: 1, source: 'model', prompt, adapter: 'anthropic',
      model: { provider: 'anthropic', requested: 'claude-x', reported: 'claude-x-20260101' },
      sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT },
      usage: { input_tokens: 1000, output_tokens: 200, source: 'provider' },
      latency_ms: 850,
      cost: { usd: 0.006, basis: 'provider-usage', pricing: { input_per_mtok: 3, output_per_mtok: 15, table_version: '2026-11-01' } },
      response: DIGEST
    });
    assertNoBlanks(p);
  });

  it('an adapter that reports nothing is recorded as explicit unknowns, never blanks', () => {
    const p = modelProvenance({ provider: 'someone', requested: 'm', prompt, meta: null, ...EXTRA, response: UNKNOWN });
    expect(p.model).toEqual({ provider: 'someone', requested: 'm', reported: UNKNOWN });
    expect(p.sampling).toEqual({ temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN });
    expect(p.adapter).toBe(UNKNOWN);
    assertNoBlanks(p);
  });

  it('a composite model records the member that answered and names the composite it went through', () => {
    const p = modelProvenance({ provider: 'composite', requested: 'composite-1', prompt, meta: { ...META, member: { provider: 'openai', requested: 'gpt-x' } }, ...EXTRA });
    expect(p.model).toEqual({ provider: 'openai', requested: 'gpt-x', reported: 'claude-x-20260101', via: 'composite-1' });
  });

  it('a pipeline keeps every step that contributed', () => {
    const steps = [{ provider: 'openai', requested: 'a', reported: 'a-1' }, { provider: 'anthropic', requested: 'b', reported: UNKNOWN }];
    const p = modelProvenance({ provider: 'composite', requested: 'pipe', prompt, meta: { ...META, member: { provider: 'anthropic', requested: 'b' }, steps }, ...EXTRA });
    expect(p.model!.steps).toEqual(steps);
    assertNoBlanks(p);
  });

  it('survives a JSON round trip unchanged (it is stored as JSONB and hashed in canonical form)', () => {
    const p = modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META, ...EXTRA });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe('moves that did not come from a model', () => {
  it('the mock model is a seeded random player: no prompt, no sampling, and it says so', () => {
    expect(randomProvenance('mock', 'mock-fast')).toEqual({ v: 1, source: 'random', prompt: null, model: { provider: 'mock', requested: 'mock-fast', reported: 'mock' }, sampling: null, adapter: 'seeded-random', usage: null, latency_ms: null, cost: null, response: null });
  });
  it('an engine move has no model at all', () => {
    expect(engineProvenance()).toEqual({ v: 1, source: 'engine', prompt: null, model: null, sampling: null, adapter: null, usage: null, latency_ms: null, cost: null, response: null });
  });
  it('null here means "does not apply", and the source field says why', () => {
    for (const p of [randomProvenance('mock', 'm'), engineProvenance()]) { expect(['random', 'engine']).toContain(p.source); assertNoBlanks({ ...p, prompt: p.prompt ?? 'n/a' }); }
  });
});

describe('tokens, latency, cost and the response digest', () => {
  const prompt = promptIdentity('chess', 'white', 'sys', '1.1.0');

  it('tokens are the provider\'s when it reported both, otherwise our estimate, labelled as estimated', () => {
    expect(tokenUsage({ input_tokens: 10, output_tokens: 3 }, { input: 99, output: 98 })).toEqual({ input_tokens: 10, output_tokens: 3, source: 'provider' });
    for (const partial of [undefined, { input_tokens: 10, output_tokens: UNKNOWN }, { input_tokens: UNKNOWN, output_tokens: 3 }]) {
      expect(tokenUsage(partial as any, { input: 99, output: 98 })).toEqual({ input_tokens: 99, output_tokens: 98, source: 'estimated' });
    }
  });

  it('a model without a price has an unknown cost, not a zero one', () => {
    const p = modelProvenance({ provider: 'openai', requested: 'gpt-none', prompt, meta: null, ...EXTRA });
    expect(p.cost).toEqual({ usd: UNKNOWN, basis: UNKNOWN, pricing: UNKNOWN });
  });

  it('a cost from estimated tokens says so', () => {
    const p = modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: null, ...EXTRA, usage: { input_tokens: 1000, output_tokens: 200, source: 'estimated' } });
    expect(p.cost).toMatchObject({ usd: 0.006, basis: 'estimated-usage' });
  });

  it('a composite is priced as the member that answered', () => {
    const p = modelProvenance({ provider: 'composite', requested: 'comp', prompt, meta: { ...META, member: { provider: 'anthropic', requested: 'claude-x-2' } }, ...EXTRA });
    expect(p.cost).toMatchObject({ usd: 0.006 });
    expect(p.model).toMatchObject({ provider: 'anthropic', via: 'comp' });
  });

  it('the response digest is carried as given, or is `unknown` when the adapter keeps no response', () => {
    expect(modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META, ...EXTRA }).response).toEqual(DIGEST);
    expect(modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META, ...EXTRA, response: UNKNOWN }).response).toBe(UNKNOWN);
  });
});
