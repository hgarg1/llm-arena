process.env.MATCH_QUEUE_ENABLED = 'true';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.DATABASE_URL = 'postgres://test';

const matchCreate = jest.fn();
const updateStatus = jest.fn();
const queueAdd = jest.fn();
const findArtifact = jest.fn();

jest.mock('../src/config/db', () => ({ prisma: { gameEngineArtifact: { findFirst: (...a: any[]) => findArtifact(...a) } } }));
jest.mock('../src/repositories/match.repository', () => ({
  MatchRepository: class { create = matchCreate; updateStatus = updateStatus; findById = jest.fn(); findAll = jest.fn(); }
}));
jest.mock('../src/services/queue', () => ({ matchQueue: { add: (...a: any[]) => queueAdd(...a) } }));
jest.mock('../src/services/settings.service', () => ({ settingsService: { getAll: async () => ({ queue_retry_attempts: '4', queue_retry_backoff_ms: '250' }) } }));

import { MatchService } from '../src/services/match.service';

beforeEach(() => {
  [matchCreate, updateStatus, queueAdd, findArtifact].forEach(m => m.mockReset());
  matchCreate.mockResolvedValue({ id: 'match-1' });
});

describe('MatchService.createMatch', () => {
  it('stores the options and enqueues with the configured retry policy', async () => {
    await new MatchService().createMatch([{ modelId: 'a', role: 'white' }], 'chess', { maxPlies: 50 }, 'u1');
    expect(matchCreate.mock.calls[0][0]).toMatchObject({ game_type: 'chess', options: { maxPlies: 50 } });
    expect(matchCreate.mock.calls[0][0].engine_artifact_id).toBeUndefined();
    expect(findArtifact.mock.calls[0][0].where).toMatchObject({ kind: 'NATIVE', game: { key: 'chess' } });
    expect(queueAdd).toHaveBeenCalledWith('run-match', { matchId: 'match-1', options: { maxPlies: 50 } }, { attempts: 4, backoff: { type: 'fixed', delay: 250 } });
  });

  it('pins a built-in game to its native artifact row', async () => {
    findArtifact.mockResolvedValue({ id: 'native-1' });
    await new MatchService().createMatch([{ modelId: 'a', role: 'white' }], 'chess', {}, 'u1');
    expect(matchCreate.mock.calls[0][0].engine_artifact_id).toBe('native-1');
  });

  it('pins a generated game to the artifact that is published right now', async () => {
    findArtifact.mockResolvedValue({ id: 'art-7' });
    await new MatchService().createMatch([{ modelId: 'a' }], 'my-game', {}, 'u1');
    expect(matchCreate.mock.calls[0][0].engine_artifact_id).toBe('art-7');
    expect(findArtifact.mock.calls[0][0].where).toMatchObject({ status: 'PUBLISHED', game: { key: 'my-game' } });
  });

  it('marks the match FAILED (never leaves it PENDING) when the runner cannot be started', async () => {
    queueAdd.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new MatchService().createMatch([{ modelId: 'a' }], 'chess', {}, 'u1')).rejects.toThrow(/runner is unavailable/);
    expect(updateStatus).toHaveBeenCalledWith('match-1', 'FAILED', undefined, expect.stringMatching(/Could not start match.*ECONNREFUSED/));
  });
});
