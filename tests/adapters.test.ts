import axios from 'axios';
import { AnthropicAdapter, GoogleAdapter, OpenAICompatibleAdapter, CompositeAdapter, ModelUnavailableError, buildChatMessages } from '../src/game/adapters';
import { GameEvent, ModelAdapter, PROVIDER_DEFAULT, UNKNOWN } from '../src/game/types';

jest.mock('axios');
const post = axios.post as jest.Mock;

jest.mock('../src/config/db', () => ({ prisma: {} }));

const history: GameEvent[] = [
  { turn: 0, actor: 'system', type: 'START', payload: { n: 1 } },
  { turn: 1, actor: 'white', type: 'MOVE', payload: { content: 'e2e4' } },
  { turn: 2, actor: 'black', type: 'MOVE', payload: { content: 'e7e5' } },
  { turn: 3, actor: 'white', type: 'MOVE', payload: { content: 'g1f3' } }
];

beforeEach(() => post.mockReset());

describe('buildChatMessages', () => {
  it("marks the player's own moves as assistant turns and merges consecutive turns", () => {
    const msgs = buildChatMessages(history, 'white');
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[1].content).toBe('e2e4');
    expect(msgs[msgs.length - 1].content).toMatch(/your move \(white\)/i);
  });

  it('always starts with a user message and never repeats a role', () => {
    const msgs = buildChatMessages([{ turn: 0, actor: 'white', type: 'M', payload: { content: 'x' } }], 'white');
    expect(msgs[0].role).toBe('user');
    msgs.slice(1).forEach((m, i) => expect(m.role).not.toBe(msgs[i].role));
  });
});

describe('provider adapters', () => {
  it('OpenAI: returns the completion text and sends assistant/user roles', async () => {
    post.mockResolvedValue({ data: { choices: [{ message: { content: 'e2e4' } }] } });
    const adapter = new OpenAICompatibleAdapter('key', 'gpt-4o');
    await expect(adapter.generateMove('sys', history, 'white')).resolves.toBe('e2e4');
    const body = post.mock.calls[0][1];
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages.map((m: any) => m.role)).toContain('assistant');
    expect(body.temperature).toBe(0);
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it('OpenAI: omits temperature for reasoning models', async () => {
    post.mockResolvedValue({ data: { choices: [{ message: { content: 'ok' } }] } });
    await new OpenAICompatibleAdapter('key', 'o3-mini').generateMove('s', history, 'white');
    expect(post.mock.calls[0][1]).not.toHaveProperty('temperature');
  });

  it('throws ModelUnavailableError instead of returning an error string', async () => {
    post.mockRejectedValue({ message: 'Request failed', response: { status: 429, data: { error: { message: 'rate limited' } } } });
    await expect(new OpenAICompatibleAdapter('key', 'gpt-4o').generateMove('s', history, 'white')).rejects.toThrow(/429.*rate limited/);
    await expect(new OpenAICompatibleAdapter('key', 'gpt-4o').generateMove('s', history, 'white')).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('throws on empty completions and missing keys', async () => {
    post.mockResolvedValue({ data: { choices: [] } });
    await expect(new OpenAICompatibleAdapter('key', 'm').generateMove('s', history, 'white')).rejects.toThrow(ModelUnavailableError);
    await expect(new OpenAICompatibleAdapter('', 'm').generateMove('s', history, 'white')).rejects.toThrow(/No API key/);
  });

  it('Anthropic: sends alternating roles, system prompt, and joins text blocks', async () => {
    post.mockResolvedValue({ data: { content: [{ type: 'text', text: 'e2' }, { type: 'text', text: 'e4' }] } });
    await expect(new AnthropicAdapter('key', 'claude').generateMove('sys', history, 'white')).resolves.toBe('e2e4');
    const body = post.mock.calls[0][1];
    expect(body.system).toBe('sys');
    expect(body.messages[0].role).toBe('user');
    body.messages.slice(1).forEach((m: any, i: number) => expect(m.role).not.toBe(body.messages[i].role));
  });

  it('Anthropic: propagates failures', async () => {
    post.mockRejectedValue(new Error('network down'));
    await expect(new AnthropicAdapter('key', 'claude').generateMove('s', history, 'white')).rejects.toThrow(/network down/);
  });

  it('Google: uses a header for the key (not the URL) and system instruction', async () => {
    post.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: 'e2e4' }] } }] } });
    await expect(new GoogleAdapter('secret', 'gemini').generateMove('sys', history, 'white')).resolves.toBe('e2e4');
    expect(post.mock.calls[0][0]).not.toContain('secret');
    expect(post.mock.calls[0][2].headers['x-goog-api-key']).toBe('secret');
    expect(post.mock.calls[0][1].systemInstruction.parts[0].text).toBe('sys');
  });
});

describe('CompositeAdapter', () => {
  const build = (strategy: string, members: Array<(...a: any[]) => Promise<string>>) => {
    const composite = new CompositeAdapter('model');
    (composite as any).initialized = true;
    (composite as any).strategy = strategy;
    (composite as any).adapters = members.map(fn => ({ adapter: { generateMove: fn }, weight: 1 }));
    (composite as any).pipeline = members.map(fn => ({ adapter: { generateMove: fn } }));
    return composite;
  };

  it('FALLBACK moves on to the next member when one throws', async () => {
    const c = build('FALLBACK', [async () => { throw new Error('down'); }, async () => 'move']);
    await expect(c.generateMove('s', history, 'white')).resolves.toBe('move');
  });

  it('FALLBACK throws when every member fails', async () => {
    const c = build('FALLBACK', [async () => { throw new Error('a'); }, async () => { throw new Error('b'); }]);
    await expect(c.generateMove('s', history, 'white')).rejects.toThrow('b');
  });

  it('ROUND_ROBIN rotates members and surfaces failures', async () => {
    const c = build('ROUND_ROBIN', [async () => 'one', async () => 'two']);
    expect(await c.generateMove('s', history, 'white')).toBe('one');
    expect(await c.generateMove('s', history, 'white')).toBe('two');
    const bad = build('ROUND_ROBIN', [async () => { throw new Error('x'); }]);
    await expect(bad.generateMove('s', history, 'white')).rejects.toThrow('x');
  });

  it('PIPELINE passes each output to the next step and stops on failure', async () => {
    const seen: string[] = [];
    const c = build('PIPELINE', [async () => 'draft', async (prompt: string) => { seen.push(prompt); return 'final'; }]);
    expect(await c.generateMove('sys', history, 'white')).toBe('final');
    expect(seen[0]).toContain('draft');
    const bad = build('PIPELINE', [async () => { throw new Error('step failed'); }, async () => 'never']);
    await expect(bad.generateMove('sys', history, 'white')).rejects.toThrow('step failed');
  });
});

describe('rate limit errors', () => {
  const { parseRetryAfter } = jest.requireActual('../src/game/adapters');

  it('parseRetryAfter understands seconds, HTTP dates, and caps absurd values', () => {
    expect(parseRetryAfter('7')).toBe(7000);
    expect(parseRetryAfter(['3'])).toBe(3000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('99999')).toBe(120_000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBeUndefined(); // already past
    for (const bad of [undefined, null, '', 'soon', '-5']) expect(parseRetryAfter(bad)).toBeUndefined();
  });

  it('a 429 becomes a rateLimited error carrying Retry-After, for every provider', async () => {
    const e429 = { message: 'Too Many Requests', response: { status: 429, headers: { 'retry-after': '12' }, data: { error: { message: 'slow down' } } } };
    for (const adapter of [new OpenAICompatibleAdapter('k', 'm'), new AnthropicAdapter('k', 'm'), new GoogleAdapter('k', 'm')]) {
      post.mockReset().mockRejectedValue(e429);
      const err: any = await adapter.generateMove('s', history, 'white').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelUnavailableError);
      expect(err.rateLimited).toBe(true);
      expect(err.retryAfterMs).toBe(12_000);
    }
  });

  it('other errors are not rate limited', async () => {
    post.mockReset().mockRejectedValue({ message: 'boom', response: { status: 500, headers: {} } });
    const err: any = await new OpenAICompatibleAdapter('k', 'm').generateMove('s', history, 'white').catch((e: unknown) => e);
    expect(err.rateLimited).toBe(false);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('the per-call timeout from the runner is honoured', async () => {
    post.mockReset().mockResolvedValue({ data: { choices: [{ message: { content: 'x' } }] } });
    await new OpenAICompatibleAdapter('k', 'm').generateMove('s', history, 'white', { timeoutMs: 12_345 });
    expect(post.mock.calls[0][2].timeout).toBe(12_345);
  });
});

describe('what adapters report about a call (provenance)', () => {
  it('OpenAI-compatible: the model the provider echoed and the sampling it was sent', async () => {
    post.mockResolvedValue({ data: { model: 'gpt-4o-2026-01-01', choices: [{ message: { content: 'e2e4' } }] } });
    const call = await new OpenAICompatibleAdapter('key', 'gpt-4o').generateMoveWithMeta('sys', history, 'white');
    expect(call.text).toBe('e2e4');
    expect(call.meta).toEqual({ adapter: 'openai-compatible', model_reported: 'gpt-4o-2026-01-01', sampling: { temperature: 0, max_tokens: PROVIDER_DEFAULT, top_p: PROVIDER_DEFAULT } });
  });

  it('OpenAI-compatible: a reasoning model gets the provider default temperature, and says so', async () => {
    post.mockResolvedValue({ data: { model: 'o3-mini', choices: [{ message: { content: 'ok' } }] } });
    const { meta } = await new OpenAICompatibleAdapter('key', 'o3-mini').generateMoveWithMeta('s', history, 'white');
    expect(meta.sampling.temperature).toBe(PROVIDER_DEFAULT);
  });

  it('a provider that does not echo the model is recorded as `unknown`, never blank', async () => {
    for (const body of [{}, { model: '' }, { model: null }, { model: 5 }]) {
      post.mockResolvedValue({ data: { ...body, choices: [{ message: { content: 'x' } }] } });
      expect((await new OpenAICompatibleAdapter('key', 'm').generateMoveWithMeta('s', history, 'white')).meta.model_reported).toBe(UNKNOWN);
    }
  });

  it('Anthropic: reports the model and the exact sampling it sent', async () => {
    post.mockResolvedValue({ data: { model: 'claude-x-20260101', content: [{ type: 'text', text: 'e2e4' }] } });
    const { meta } = await new AnthropicAdapter('key', 'claude-x').generateMoveWithMeta('sys', history, 'white');
    expect(meta).toEqual({ adapter: 'anthropic', model_reported: 'claude-x-20260101', sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT } });
    expect(post.mock.calls[0][1]).toMatchObject({ temperature: 0, max_tokens: 1024 }); // what is recorded is what was sent
  });

  it('Google: reports modelVersion, or unknown when absent', async () => {
    post.mockResolvedValue({ data: { modelVersion: 'gemini-x-002', candidates: [{ content: { parts: [{ text: 'e2e4' }] } }] } });
    expect((await new GoogleAdapter('key', 'gemini-x').generateMoveWithMeta('sys', history, 'white')).meta).toEqual({ adapter: 'google', model_reported: 'gemini-x-002', sampling: { temperature: 0, max_tokens: PROVIDER_DEFAULT, top_p: PROVIDER_DEFAULT } });
    post.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: 'e2e4' }] } }] } });
    expect((await new GoogleAdapter('key', 'gemini-x').generateMoveWithMeta('sys', history, 'white')).meta.model_reported).toBe(UNKNOWN);
  });

  it('generateMove still returns just the text, for every adapter', async () => {
    post.mockResolvedValue({ data: { model: 'm', choices: [{ message: { content: 'abc' } }] } });
    await expect(new OpenAICompatibleAdapter('key', 'm').generateMove('s', history, 'white')).resolves.toBe('abc');
  });

  it('a failing call still throws (provenance never turns an outage into a move)', async () => {
    post.mockRejectedValue({ response: { status: 500, data: { error: { message: 'boom' } } } });
    await expect(new OpenAICompatibleAdapter('key', 'm').generateMoveWithMeta('s', history, 'white')).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  describe('composite models say which member answered', () => {
    type Member = { adapter: ModelAdapter; provider: string; modelId: string };
    const build = (strategy: string, members: Member[]) => {
      const c = new CompositeAdapter('comp-1');
      (c as any).initialized = true;
      (c as any).strategy = strategy;
      (c as any).adapters = members.map(m => ({ ...m, weight: 1 }));
      (c as any).pipeline = members.map(m => ({ ...m }));
      return c;
    };
    const openai = (id: string): Member => ({ adapter: new OpenAICompatibleAdapter('key', id), provider: 'openai', modelId: id });
    const anthropic = (id: string): Member => ({ adapter: new AnthropicAdapter('key', id), provider: 'anthropic', modelId: id });

    it('round robin: the member that answered, with its own report', async () => {
      post.mockResolvedValue({ data: { model: 'gpt-x-1', choices: [{ message: { content: 'move' } }] } });
      const { text, meta } = await build('ROUND_ROBIN', [openai('gpt-x')]).generateMoveWithMeta('sys', history, 'white');
      expect(text).toBe('move');
      expect(meta).toMatchObject({ adapter: 'openai-compatible', model_reported: 'gpt-x-1', member: { provider: 'openai', requested: 'gpt-x' } });
    });

    it('fallback: the member that finally answered, not the ones that failed', async () => {
      post.mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValueOnce({ data: { model: 'claude-y-1', content: [{ type: 'text', text: 'ok' }] } });
      const { meta } = await build('FALLBACK', [openai('gpt-x'), anthropic('claude-y')]).generateMoveWithMeta('sys', history, 'white');
      expect(meta.member).toEqual({ provider: 'anthropic', requested: 'claude-y' });
      expect(meta.model_reported).toBe('claude-y-1');
    });

    it('pipeline: every step is listed in order, and the last one answered', async () => {
      post.mockResolvedValueOnce({ data: { model: 'step-1', choices: [{ message: { content: 'draft' } }] } })
        .mockResolvedValueOnce({ data: { model: 'claude-final', content: [{ type: 'text', text: 'final' }] } });
      const { text, meta } = await build('PIPELINE', [openai('a'), anthropic('b')]).generateMoveWithMeta('sys', history, 'white');
      expect(text).toBe('final');
      expect(meta.steps).toEqual([{ provider: 'openai', requested: 'a', reported: 'step-1' }, { provider: 'anthropic', requested: 'b', reported: 'claude-final' }]);
      expect(meta.member).toEqual({ provider: 'anthropic', requested: 'b' });
    });

    it('a member that cannot report is recorded as unknown markers, never blank', async () => {
      const plain: Member = { adapter: { generateMove: async () => 'text' }, provider: 'custom', modelId: 'x' };
      const { text, meta } = await build('ROUND_ROBIN', [plain]).generateMoveWithMeta('sys', history, 'white');
      expect(text).toBe('text');
      expect(meta).toMatchObject({ adapter: UNKNOWN, model_reported: UNKNOWN, sampling: { temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN }, member: { provider: 'custom', requested: 'x' } });
    });

    it('generateMove on a composite still returns just the text', async () => {
      post.mockResolvedValue({ data: { model: 'm', choices: [{ message: { content: 'abc' } }] } });
      await expect(build('ROUND_ROBIN', [openai('m')]).generateMove('sys', history, 'white')).resolves.toBe('abc');
    });
  });
});
