/** Per-move provenance: what is recorded for each kind of move, and the rule that no field is ever blank. */
import { createHash } from 'crypto';
import { CallMeta, UNKNOWN, PROVIDER_DEFAULT } from '../src/game/types';
import { engineProvenance, modelProvenance, promptIdentity, randomProvenance } from '../src/integrity/provenance';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Every value is a real value, one of the markers, or an explicit null for a part that does not apply. Never '' or undefined. */
const assertNoBlanks = (value: unknown, path = 'provenance') => {
  expect(value).not.toBeUndefined();
  if (typeof value === 'string') expect({ path, blank: value.trim() === '' }).toEqual({ path, blank: false });
  else if (Array.isArray(value)) value.forEach((v, i) => assertNoBlanks(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoBlanks(v, `${path}.${k}`);
};

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
    const p = modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META });
    expect(p).toEqual({
      v: 1, source: 'model', prompt, adapter: 'anthropic',
      model: { provider: 'anthropic', requested: 'claude-x', reported: 'claude-x-20260101' },
      sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT }
    });
    assertNoBlanks(p);
  });

  it('an adapter that reports nothing is recorded as explicit unknowns, never blanks', () => {
    const p = modelProvenance({ provider: 'someone', requested: 'm', prompt, meta: null });
    expect(p.model).toEqual({ provider: 'someone', requested: 'm', reported: UNKNOWN });
    expect(p.sampling).toEqual({ temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN });
    expect(p.adapter).toBe(UNKNOWN);
    assertNoBlanks(p);
  });

  it('a composite model records the member that answered and names the composite it went through', () => {
    const p = modelProvenance({ provider: 'composite', requested: 'composite-1', prompt, meta: { ...META, member: { provider: 'openai', requested: 'gpt-x' } } });
    expect(p.model).toEqual({ provider: 'openai', requested: 'gpt-x', reported: 'claude-x-20260101', via: 'composite-1' });
  });

  it('a pipeline keeps every step that contributed', () => {
    const steps = [{ provider: 'openai', requested: 'a', reported: 'a-1' }, { provider: 'anthropic', requested: 'b', reported: UNKNOWN }];
    const p = modelProvenance({ provider: 'composite', requested: 'pipe', prompt, meta: { ...META, member: { provider: 'anthropic', requested: 'b' }, steps } });
    expect(p.model!.steps).toEqual(steps);
    assertNoBlanks(p);
  });

  it('survives a JSON round trip unchanged (it is stored as JSONB and hashed in canonical form)', () => {
    const p = modelProvenance({ provider: 'anthropic', requested: 'claude-x', prompt, meta: META });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe('moves that did not come from a model', () => {
  it('the mock model is a seeded random player: no prompt, no sampling, and it says so', () => {
    expect(randomProvenance('mock', 'mock-fast')).toEqual({ v: 1, source: 'random', prompt: null, model: { provider: 'mock', requested: 'mock-fast', reported: 'mock' }, sampling: null, adapter: 'seeded-random' });
  });
  it('an engine move has no model at all', () => {
    expect(engineProvenance()).toEqual({ v: 1, source: 'engine', prompt: null, model: null, sampling: null, adapter: null });
  });
  it('null here means "does not apply", and the source field says why', () => {
    for (const p of [randomProvenance('mock', 'm'), engineProvenance()]) { expect(['random', 'engine']).toContain(p.source); assertNoBlanks({ ...p, prompt: p.prompt ?? 'n/a' }); }
  });
});
