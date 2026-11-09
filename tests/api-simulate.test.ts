jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: jest.fn().mockResolvedValue(null) } } }));
import { simulate } from '../src/controllers/api/games.controller';

const call = async (gameId: string, body: any) => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await simulate({ params: { gameId }, body } as any, res);
  return res;
};

describe('POST /api/games/:gameId/simulate', () => {
  it('initialises when no move is given', async () => {
    const res = await call('chess', { seed: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.body.nextState[0].type).toBe('MATCH_START');
    expect(res.body.seed).toBe(5);
  });

  it('applies a move to a fresh game', async () => {
    const res = await call('chess', { seed: 5, move: { actor: 'white', content: 'e2e4' } });
    expect(res.body.events[0]).toMatchObject({ type: 'MOVE', payload: { san: 'e4' } });
  });

  it('replays prior moves so stateful engines stay in sync', async () => {
    const res = await call('chess', {
      seed: 5,
      moves: [{ actor: 'white', content: 'e2e4' }, { actor: 'black', content: 'e7e5' }],
      move: { actor: 'white', content: 'g1f3' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.events[0].payload.san).toBe('Nf3');
    // Without the replay the same move would be wrong-side: black to move after 1.e4 alone.
    const bad = await call('chess', { seed: 5, moves: [{ actor: 'white', content: 'e2e4' }], move: { actor: 'white', content: 'g1f3' } });
    expect(bad.body.events[0].type).toBe('ILLEGAL_MOVE');
  });

  it('refuses an untrusted client-side state log', async () => {
    const res = await call('chess', { state: [{}, {}], move: { actor: 'white', content: 'e2e4' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/moves/);
  });

  it('validates move shape and replay size', async () => {
    expect((await call('chess', { moves: [{ actor: 1 }] })).statusCode).toBe(400);
    expect((await call('chess', { moves: new Array(1001).fill({ actor: 'white', content: 'e2e4' }) })).statusCode).toBe(400);
  });

  it('returns 409 when moving after the game ended', async () => {
    const res = await call('chess', { moves: [{ actor: 'white', content: 'e2e5' }], move: { actor: 'black', content: 'e7e5' } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 for an unknown game', async () => {
    expect((await call('nope', {})).statusCode).toBe(404);
  });

  it('returns 500 when an engine throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Poker throws when asked to move out of turn.
    const res = await call('texas_holdem', { options: { playerCount: 2, dealerIndex: 0 }, move: { actor: 'seat2', content: 'CALL' } });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/Out of turn/);
    spy.mockRestore();
  });
});
