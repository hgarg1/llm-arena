import { MatchRepository } from './match.repository';
import { prisma } from '../config/db';

// Mock the db config
jest.mock('../config/db', () => ({
  prisma: {
    matchEvent: {
      create: jest.fn(),
      createMany: jest.fn(),
    },
  },
}));

describe('MatchRepository', () => {
  let repository: MatchRepository;

  beforeEach(() => {
    repository = new MatchRepository();
    jest.clearAllMocks();
  });

  it('baseline: addEvent calls create N times', async () => {
    const events = Array.from({ length: 10 }).map((_, i) => ({
      match: { connect: { id: 'match-1' } },
      turn_index: i,
      type: 'test',
      payload: {},
    }));

    for (const event of events) {
      await repository.addEvent(event);
    }

    expect(prisma.matchEvent.create).toHaveBeenCalledTimes(10);
  });

  it('optimization: addEvents calls createMany once', async () => {
    const events = Array.from({ length: 10 }).map((_, i) => ({
      match_id: 'match-1',
      turn_index: i,
      type: 'test',
      payload: {},
    }));

    await repository.addEvents(events);

    expect(prisma.matchEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.matchEvent.createMany).toHaveBeenCalledWith({ data: events });
  });
});
