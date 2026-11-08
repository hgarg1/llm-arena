const findMany = jest.fn();
const updateManyRelease = jest.fn();
const updateManyGame = jest.fn();
jest.mock('../src/config/db', () => ({
  prisma: {
    gameRelease: { findMany: (...a: any[]) => findMany(...a), updateMany: (...a: any[]) => updateManyRelease(...a) },
    gameDefinition: { updateMany: (...a: any[]) => updateManyGame(...a) },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops)
  }
}));

import { activateDueScheduledGames } from '../src/services/game-release.service';

const release = (id: string, key: string, artifacts: number) => ({ id, game_id: `g-${id}`, game: { key, engine_artifacts: new Array(artifacts).fill({ id: 'a' }) } });

beforeEach(() => [findMany, updateManyRelease, updateManyGame].forEach(m => { m.mockReset(); m.mockResolvedValue({}); }));

describe('scheduled releases', () => {
  it('does nothing when nothing is due', async () => {
    findMany.mockResolvedValue([]);
    await activateDueScheduledGames();
    expect(updateManyRelease).not.toHaveBeenCalled();
  });

  it('activates games that still have a published runtime', async () => {
    findMany.mockResolvedValue([release('r1', 'my-game', 1), release('r2', 'chess', 0)]);
    await activateDueScheduledGames();
    expect(updateManyRelease).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] } }, data: { status: 'LIVE', publish_at: null } });
    expect(updateManyGame.mock.calls[0][0].where.id.in).toEqual(['g-r1', 'g-r2']);
  });

  it('reverts a due release to DRAFT when its runtime was unpublished in the meantime', async () => {
    findMany.mockResolvedValue([release('r1', 'my-game', 0), release('r2', 'other', 1)]);
    await activateDueScheduledGames();
    expect(updateManyRelease).toHaveBeenCalledWith({ where: { id: { in: ['r1'] } }, data: { status: 'DRAFT', publish_at: null } });
    expect(updateManyRelease).toHaveBeenCalledWith({ where: { id: { in: ['r2'] } }, data: { status: 'LIVE', publish_at: null } });
    expect(updateManyGame.mock.calls[0][0].where.id.in).toEqual(['g-r2']);
  });
});
