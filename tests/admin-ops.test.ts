process.env.MATCH_QUEUE_ENABLED = 'true';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.DATABASE_URL = 'postgres://test';

const prismaMock: any = { match: { updateMany: jest.fn(), findUnique: jest.fn() }, matchManifest: { deleteMany: jest.fn() } };
const queue = { getJobs: jest.fn(), add: jest.fn() };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));
jest.mock('../src/services/queue', () => ({ matchQueue: queue }));
jest.mock('../src/services/settings.service', () => ({ settingsService: { getAll: async () => ({ queue_retry_attempts: '2', queue_retry_backoff_ms: '100' }) } }));
jest.mock('bcrypt', () => ({}));
jest.mock('../src/services/audit.service', () => ({ logAdminAction: jest.fn() }));

import { cancelMatch, retryMatch } from '../src/controllers/admin.controller';

const call = async (fn: any, id: string) => {
  const res: any = { redirected: '' };
  res.redirect = (u: string) => { res.redirected = decodeURIComponent(u); };
  await fn({ params: { id }, session: { userId: 'admin' } } as any, res);
  return res;
};

beforeEach(() => {
  prismaMock.match.updateMany.mockReset();
  prismaMock.match.findUnique.mockReset();
  prismaMock.matchManifest.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  queue.getJobs.mockReset().mockResolvedValue([]);
  queue.add.mockReset();
});

describe('admin match cancel', () => {
  it('cancels only pending/running matches, atomically', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 1 });
    const res = await call(cancelMatch, 'm1');
    expect(prismaMock.match.updateMany.mock.calls[0][0].where).toEqual({ id: 'm1', status: { in: ['PENDING', 'RUNNING'] } });
    expect(prismaMock.match.updateMany.mock.calls[0][0].data.status).toBe('CANCELLED');
    expect(res.redirected).toContain('success=Match cancelled');
  });

  it('refuses a match that already finished', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 0 });
    const res = await call(cancelMatch, 'm1');
    expect(res.redirected).toMatch(/Only pending or running matches/);
    expect(queue.getJobs).not.toHaveBeenCalled();
  });

  it('removes a waiting job but tolerates an active (locked) one', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 1 });
    const remove = jest.fn().mockRejectedValue(new Error('Job is locked'));
    queue.getJobs.mockResolvedValue([{ data: { matchId: 'other' }, remove: jest.fn() }, { data: { matchId: 'm1' }, remove }]);
    const res = await call(cancelMatch, 'm1');
    expect(remove).toHaveBeenCalled();
    expect(res.redirected).toContain('success=Match cancelled');
  });
});

describe('admin match retry', () => {
  it('re-queues a failed match with its stored options', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.match.findUnique.mockResolvedValue({ options: { playerCount: 3 } });
    const res = await call(retryMatch, 'm1');
    expect(prismaMock.match.updateMany.mock.calls[0][0].where).toEqual({ id: 'm1', status: { in: ['FAILED', 'CANCELLED'] } });
    expect(queue.add).toHaveBeenCalledWith('run-match', { matchId: 'm1', options: { playerCount: 3 } }, { attempts: 2, backoff: { type: 'fixed', delay: 100 } });
    expect(res.redirected).toContain('Match retry queued');
    // the match is no longer final, so its signed manifest must not outlive the retry
    expect(prismaMock.matchManifest.deleteMany).toHaveBeenCalledWith({ where: { match_id: 'm1' } });
  });

  it('will not re-queue a running or completed match (it would be played twice)', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 0 });
    const res = await call(retryMatch, 'm1');
    expect(res.redirected).toMatch(/Only failed or cancelled matches/);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prismaMock.matchManifest.deleteMany).not.toHaveBeenCalled(); // a completed match keeps its manifest
  });
});
