const prismaMock: any = { match: { updateMany: jest.fn(), count: jest.fn(), findMany: jest.fn() }, moveRawResponse: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() } };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));

import { sweepMatches } from '../src/services/runner/sweeper';

const saved = { ...process.env };
const now = new Date('2026-06-01T12:00:00Z');

beforeEach(() => {
  process.env = { ...saved };
  delete process.env.MATCH_RUNNER_CONCURRENCY;
  prismaMock.match.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prismaMock.match.count.mockReset().mockResolvedValue(0);
  prismaMock.match.findMany.mockReset().mockResolvedValue([]);
});
afterAll(() => { process.env = saved; });

const queueResults = (resumable: string[], pending: string[]) => {
  prismaMock.match.findMany.mockImplementation(async ({ where }: any) =>
    (where.status === 'RUNNING' ? resumable : pending).map(id => ({ id })));
};

describe('sweepMatches', () => {
  it('resumes orphaned RUNNING matches as continuations and starts PENDING ones as new', async () => {
    queueResults(['r1', 'r2'], ['p1']);
    const dispatch = jest.fn().mockResolvedValue(true);
    const result = await sweepMatches(now, dispatch);
    expect(dispatch).toHaveBeenCalledWith('r1', { continuation: true });
    expect(dispatch).toHaveBeenCalledWith('r2', { continuation: true });
    expect(dispatch).toHaveBeenCalledWith('p1', { continuation: false });
    expect(result).toMatchObject({ resumed: 2, started: 1, expired: 0, cap: 50 });
  });

  it('only considers matches whose lease is free, and gives the creating request a head start', async () => {
    const dispatch = jest.fn();
    await sweepMatches(now, dispatch);
    const calls = prismaMock.match.findMany.mock.calls.map((c: any) => c[0].where);
    const running = calls.find((w: any) => w.status === 'RUNNING');
    const pending = calls.find((w: any) => w.status === 'PENDING');
    expect(running.OR).toEqual([{ lease_expires_at: null }, { lease_expires_at: { lt: now } }]);
    expect(pending.OR).toEqual(running.OR);
    expect(pending.created_at.lt.getTime()).toBe(now.getTime() - 15_000);
  });

  it('admission control: new matches only start while below the concurrency cap', async () => {
    process.env.MATCH_RUNNER_CONCURRENCY = '5';
    prismaMock.match.count.mockResolvedValue(3);       // 3 active
    queueResults(['r1'], ['p1', 'p2', 'p3', 'p4']);     // 1 resumable => room for 1 more
    const dispatch = jest.fn().mockResolvedValue(true);
    const result = await sweepMatches(now, dispatch);
    const pendingQuery = prismaMock.match.findMany.mock.calls.map((c: any) => c[0]).find((q: any) => q.where.status === 'PENDING');
    expect(pendingQuery.take).toBe(1);
    expect(result).toMatchObject({ active: 3, cap: 5, resumed: 1 });
  });

  it('starts nothing new when the cap is already reached, but still resumes orphans', async () => {
    process.env.MATCH_RUNNER_CONCURRENCY = '2';
    prismaMock.match.count.mockResolvedValue(2);
    queueResults(['r1'], ['p1']);
    const dispatch = jest.fn().mockResolvedValue(true);
    const result = await sweepMatches(now, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('r1', { continuation: true });
    expect(result.started).toBe(0);
    expect(prismaMock.match.findMany.mock.calls.some((c: any) => c[0].where.status === 'PENDING')).toBe(false);
  });

  it('expires stale PENDING matches so an old backlog can never start by surprise', async () => {
    prismaMock.match.updateMany.mockResolvedValue({ count: 7 });
    const result = await sweepMatches(now, jest.fn());
    const call = prismaMock.match.updateMany.mock.calls[0][0];
    expect(call.where.status).toBe('PENDING');
    expect(call.where.created_at.lt.getTime()).toBe(now.getTime() - 24 * 3_600_000);
    expect(call.data).toMatchObject({ status: 'FAILED' });
    expect(call.data.failure_reason).toMatch(/Expired/);
    expect(result.expired).toBe(7);
  });

  it('one failed dispatch does not stop the others', async () => {
    queueResults(['r1', 'r2'], []);
    const dispatch = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true);
    await expect(sweepMatches(now, dispatch)).resolves.toMatchObject({ resumed: 2 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
