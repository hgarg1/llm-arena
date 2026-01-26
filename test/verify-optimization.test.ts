
import { Request, Response } from 'express';
import { listGames } from '../src/controllers/admin/games.controller';
import { prisma } from '../src/config/db';

jest.mock('../src/config/db', () => ({
  prisma: {
    gameDefinition: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    gameSetting: {
      createMany: jest.fn(),
    },
    gameUISchema: {
        create: jest.fn(),
    },
    gameRelease: {
        create: jest.fn(),
    }
  }
}));

describe('Performance Optimization Verification', () => {
  afterEach(() => {
      jest.clearAllMocks();
  });

  it('listGames should not call ensureDefaultGames (which calls findUnique)', async () => {
    const req = { query: {} } as unknown as Request;
    const res = {
      render: jest.fn(),
    } as unknown as Response;

    await listGames(req, res);

    expect(prisma.gameDefinition.findMany).toHaveBeenCalled();
    // This confirms that the N+1 queries from ensureDefaultGames are gone
    expect(prisma.gameDefinition.findUnique).not.toHaveBeenCalled();
    expect(prisma.gameDefinition.create).not.toHaveBeenCalled();
  });
});
