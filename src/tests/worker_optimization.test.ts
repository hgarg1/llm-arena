import { MatchRepository } from '../repositories/match.repository';
import { prisma } from '../config/db';

// Mock prisma
jest.mock('../config/db', () => ({
  prisma: {
    matchEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 })
    }
  }
}));

describe('MatchRepository Optimization', () => {
  let matchRepo: MatchRepository;

  beforeEach(() => {
    matchRepo = new MatchRepository();
    jest.clearAllMocks();
  });

  it('should use createMany for adding multiple events', async () => {
    const matchId = 'match-123';
    const events = [
      { turn: 1, type: 'MOVE', actor: 'player1', payload: { move: 'e4' } },
      { turn: 2, type: 'MOVE', actor: 'player2', payload: { move: 'e5' } }
    ];

    await matchRepo.addEvents(matchId, events);

    expect(prisma.matchEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.matchEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          match_id: matchId,
          turn_index: 1,
          type: 'MOVE',
          actor_role: 'player1',
          payload: { move: 'e4' }
        },
        {
          match_id: matchId,
          turn_index: 2,
          type: 'MOVE',
          actor_role: 'player2',
          payload: { move: 'e5' }
        }
      ]
    });
  });

  it('should handle empty events array correctly', async () => {
    const matchId = 'match-123';
    const events: any[] = [];

    await matchRepo.addEvents(matchId, events);

    expect(prisma.matchEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.matchEvent.createMany).toHaveBeenCalledWith({
      data: []
    });
  });
});
