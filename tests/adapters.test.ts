import axios from 'axios';
import { AnthropicAdapter, GoogleAdapter, OpenAICompatibleAdapter, CompositeAdapter, ModelUnavailableError, buildChatMessages } from '../src/game/adapters';
import { GameEvent } from '../src/game/types';

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
