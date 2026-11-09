const queryRaw = jest.fn();
const executeRaw = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: { $queryRaw: (...a: any[]) => queryRaw(...a), $executeRaw: (...a: any[]) => executeRaw(...a), usageCounter: { findUnique: jest.fn() } } }));

import { reserveUsage, releaseUsage } from '../src/services/usage-counter.service';

const flatten = (call: any[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => { queryRaw.mockReset(); executeRaw.mockReset(); });

describe('atomic quota', () => {
  it('reserves with a single conditional upsert (no separate read)', async () => {
    queryRaw.mockResolvedValue([{ count: 1 }]);
    const ok = await reserveUsage({ entitlementKey: 'matches.quota', scopeType: 'USER', scopeId: 'u1', limit: 5, window: 'day' });
    expect(ok).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = flatten(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/ON CONFLICT/);
    expect(sql).toMatch(/WHERE "UsageCounter"\.count < /);
    expect(sql).toMatch(/RETURNING count/);
  });

  it('denies when the conditional update matched no row (limit reached)', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await reserveUsage({ entitlementKey: 'k', scopeType: 'USER', scopeId: 'u', limit: 1, window: 'day' })).toBe(false);
  });

  it('release never takes the counter below zero', async () => {
    await releaseUsage({ entitlementKey: 'k', scopeType: 'USER', scopeId: 'u', window: 'day' });
    expect(flatten(executeRaw.mock.calls[0])).toMatch(/GREATEST\(count - 1, 0\)/);
  });

  it('concurrent reservations cannot exceed the limit (simulated database semantics)', async () => {
    // The database serialises the conditional upsert; model that with an in-memory counter.
    let count = 0;
    const limit = 3;
    queryRaw.mockImplementation(async () => (count < limit ? [{ count: ++count }] : []));
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      reserveUsage({ entitlementKey: 'k', scopeType: 'USER', scopeId: 'u', limit, window: 'day' })));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

