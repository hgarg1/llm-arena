import { generateEngineBundle } from '../src/services/engine-generator.service';

const game: any = {
  id: 'g', key: 'coin-flip', name: 'Coin Flip', description_short: null, description_long: null, status: 'DRAFT',
  capabilities: [], roles: ['player1', 'player2'], max_players: 2, assets: null, created_at: new Date(), updated_at: new Date(),
  settings: [], ui_schema: null
};

const GOOD = `import { GameEngine, GameEvent, GameResult, PlayerMove } from '../types';
export default class CoinFlipGame implements GameEngine {
  gameType = 'coin-flip';
  initialize(seed: number): GameEvent[] { return [{ turn: 0, actor: 'system', type: 'START', payload: {} }]; }
  processMove(h: GameEvent[], m: PlayerMove) { return { events: [], result: { isFinished: true, scores: { player1: 1, player2: 0 } } as GameResult }; }
  getSystemPrompt(r: string) { return r; }
  getRandomMove(h: GameEvent[], r: string) { return { actor: r, content: 'x' }; }
}`;
const BAD = `export default class CoinFlipGame { initialize( { }`;

const reply = (code: string, fenced = false) => {
  const body = JSON.stringify({ spec: {}, code, tests: 't', notes: 'n', ui_schema: { create_form_layout: [] } });
  const text = fenced ? '```json\n' + body + '\n```' : 'Here you go: ' + body;
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
};

const withFetch = async (responses: any[], fn: () => Promise<void>) => {
  const fetchMock = jest.fn();
  responses.forEach(r => fetchMock.mockResolvedValueOnce(r));
  const original = (globalThis as any).fetch;
  const env = { ...process.env };
  (globalThis as any).fetch = fetchMock;
  process.env.GEMINI_API_KEY = 'k';
  delete process.env.OPENAI_API_KEY;
  process.env.ENGINE_PROVIDER = 'gemini';
  try { await fn(); } finally { (globalThis as any).fetch = original; process.env = env; }
  return fetchMock;
};

describe('generateEngineBundle', () => {
  it('returns a clearly-labelled stub when no provider is configured', async () => {
    const env = { ...process.env };
    delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;
    const bundle = await generateEngineBundle(game);
    process.env = env;
    expect(bundle.usedFallback).toBe(true);
    expect(bundle.generationError).toMatch(/no engine provider credentials/);
  });

  it('parses JSON wrapped in prose or code fences, and sends the key in a header', async () => {
    const fetchMock = await withFetch([reply(GOOD)], async () => {
      const bundle = await generateEngineBundle(game);
      expect(bundle.usedFallback).toBe(false);
      expect(bundle.code).toContain('CoinFlipGame');
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain('key=');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('k');
    await withFetch([reply(GOOD, true)], async () => {
      expect((await generateEngineBundle(game)).usedFallback).toBe(false);
    });
  });

  it('asks the model to repair code that does not compile, including the diagnostics', async () => {
    const fetchMock = await withFetch([reply(BAD), reply(GOOD)], async () => {
      const bundle = await generateEngineBundle(game);
      expect(bundle.code).toBe(GOOD);
      expect(bundle.usedFallback).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairPrompt = JSON.parse(fetchMock.mock.calls[1][1].body).contents[0].parts[0].text as string;
    expect(repairPrompt).toMatch(/failed to compile/);
    expect(repairPrompt).toContain(BAD);
  });

  it('the prompt spells out the contract the validator enforces', async () => {
    const fetchMock = await withFetch([reply(GOOD)], async () => { await generateEngineBundle(game); });
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text as string;
    expect(prompt).toMatch(/getActiveRole/);
    expect(prompt).toMatch(/scores/);
    expect(prompt).toMatch(/Never use Math\.random/);
  });

  it('falls back (and says why) when the provider keeps failing', async () => {
    await withFetch([{ ok: false, status: 503, json: async () => ({}) }], async () => {
      const bundle = await generateEngineBundle(game);
      expect(bundle.usedFallback).toBe(true);
      expect(bundle.generationError).toMatch(/gemini: Gemini request failed \(503\)/);
    });
  });
});
