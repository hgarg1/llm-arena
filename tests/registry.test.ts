const findFirst = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: (...a: any[]) => findFirst(...a) } } }));

import { getGameEngine, resolveGameEngine, GameEngineNotFoundError } from '../src/game/registry';
import { ChessGame } from '../src/game/chess';

const CODE = `
export default class Dyn {
  initialize() { return [{ turn: 0, actor: 'system', type: 'S', payload: {} }]; }
  processMove(h: any, m: any) { return { events: [], result: { isFinished: true, scores: { player1: 1 } } }; }
  getSystemPrompt() { return 'p'; }
  getRandomMove(h: any, r: string) { return { actor: r, content: 'x' }; }
}`;

beforeEach(() => findFirst.mockReset());

describe('game registry', () => {
  it('returns built-ins without touching the database when nothing is pinned', async () => {
    expect(await getGameEngine('chess')).toBeInstanceOf(ChessGame);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('resolves a pinned NATIVE artifact to the built-in class', async () => {
    findFirst.mockResolvedValue({ id: 'native-1', kind: 'NATIVE', native_key: 'chess', code_ts: '' });
    const { engine, artifactId } = await resolveGameEngine('chess', 'native-1');
    expect(engine).toBeInstanceOf(ChessGame);
    expect(artifactId).toBe('native-1');
  });

  it('still runs a built-in when its pinned artifact row is gone', async () => {
    findFirst.mockResolvedValue(null);
    expect((await resolveGameEngine('chess', 'deleted')).engine).toBeInstanceOf(ChessGame);
  });

  it('rejects a NATIVE row pointing at an engine this build does not have', async () => {
    findFirst.mockResolvedValue({ id: 'x', kind: 'NATIVE', native_key: 'future-game', code_ts: '' });
    await expect(resolveGameEngine('some-game')).rejects.toThrow(/not available in this build/);
  });

  it('loads a published runtime from the database', async () => {
    findFirst.mockResolvedValue({ id: 'art-1', kind: 'SANDBOXED', code_ts: CODE });
    const { engine, artifactId } = await resolveGameEngine('my-game');
    expect(artifactId).toBe('art-1');
    expect(engine.initialize(1)[0].type).toBe('S');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ status: 'PUBLISHED', game: { key: 'my-game' } });
  });

  it('loads a pinned artifact by id, scoped to the game', async () => {
    findFirst.mockResolvedValue({ id: 'art-9', kind: 'SANDBOXED', code_ts: CODE });
    await resolveGameEngine('my-game', 'art-9');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: 'art-9', game: { key: 'my-game' } });
  });

  it('reports a missing runtime as GameEngineNotFoundError', async () => {
    findFirst.mockResolvedValue(null);
    await expect(getGameEngine('ghost')).rejects.toBeInstanceOf(GameEngineNotFoundError);
  });

  it.each(['../../etc/passwd', 'a/b', 'UPPER', '', '-lead', 'a b'])('rejects unsafe key %p without querying', async key => {
    await expect(getGameEngine(key)).rejects.toBeInstanceOf(GameEngineNotFoundError);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('surfaces compile errors from a stored artifact', async () => {
    findFirst.mockResolvedValue({ id: 'bad', kind: 'SANDBOXED', code_ts: 'export default class {' });
    await expect(getGameEngine('broken')).rejects.toThrow(/Compile failed/);
  });
});
