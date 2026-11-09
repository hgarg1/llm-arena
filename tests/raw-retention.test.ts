const prismaMock: any = { moveRawResponse: { findMany: jest.fn(), deleteMany: jest.fn() }, match: { deleteMany: jest.fn() }, matchMove: { deleteMany: jest.fn() }, matchManifest: { deleteMany: jest.fn() } };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));
const getAll = jest.fn();
jest.mock('../src/services/settings.service', () => ({ settingsService: { getAll } }));

import { parseRetentionDays, purgeExpiredRawResponses, rawRetentionDays } from '../src/services/raw-retention.service';

const now = new Date('2026-11-09T12:00:00.000Z');
beforeEach(() => {
  getAll.mockReset().mockResolvedValue({});
  prismaMock.moveRawResponse.findMany.mockReset().mockResolvedValue([]);
  prismaMock.moveRawResponse.deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe('raw response retention', () => {
  it('keeps responses for 90 days by default, and the admin setting overrides it', async () => {
    expect(await rawRetentionDays()).toBe(90);
    getAll.mockResolvedValue({ integrity_raw_retention_days: '30' });
    expect(await rawRetentionDays()).toBe(30);
    getAll.mockResolvedValue({ integrity_raw_retention_days: '0' });
    expect(await rawRetentionDays()).toBe(0);
  });

  it('falls back to 90 for anything that is not a whole number of days', () => {
    for (const bad of ['abc', '-5', 'NaN', '', ' ', '1.5', '1e3', '0x10', '123456', undefined, null, {}]) expect(parseRetentionDays(bad)).toBe(90);
    for (const [good, days] of [['0', 0], ['1', 1], [' 45 ', 45], [7, 7], ['99999', 99999]] as const) expect(parseRetentionDays(good)).toBe(days);
  });

  it('uses the admin setting when no window is passed', async () => {
    getAll.mockResolvedValue({ integrity_raw_retention_days: '10' });
    await purgeExpiredRawResponses({ now });
    expect((prismaMock.moveRawResponse.findMany.mock.calls[0][0].where.created_at.lt as Date).toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });

  it('only deletes responses older than the window', async () => {
    await purgeExpiredRawResponses({ now, days: 90 });
    const cutoff = prismaMock.moveRawResponse.findMany.mock.calls[0][0].where.created_at.lt as Date;
    expect(cutoff.toISOString()).toBe('2026-08-11T12:00:00.000Z');
  });

  it('0 days means keep forever: nothing is read or deleted', async () => {
    expect(await purgeExpiredRawResponses({ now, days: 0 })).toEqual({ deleted: 0 });
    getAll.mockResolvedValue({ integrity_raw_retention_days: '0' });
    expect(await purgeExpiredRawResponses({ now })).toEqual({ deleted: 0 });
    expect(prismaMock.moveRawResponse.findMany).not.toHaveBeenCalled();
  });

  it('deletes the expired rows in batches, bounded per sweep, and touches nothing but raw responses', async () => {
    const batch = Array.from({ length: 500 }, (_, i) => ({ match_id: 'm', move_index: i }));
    prismaMock.moveRawResponse.findMany.mockResolvedValue(batch);
    prismaMock.moveRawResponse.deleteMany.mockResolvedValue({ count: 500 });
    const result = await purgeExpiredRawResponses({ now, days: 1 });
    expect(result.deleted).toBe(5000);
    expect(prismaMock.moveRawResponse.findMany).toHaveBeenCalledTimes(10); // MAX_BATCHES
    expect(prismaMock.moveRawResponse.deleteMany.mock.calls[0][0].where.OR).toHaveLength(500);
    for (const other of ['match', 'matchMove', 'matchManifest']) expect(prismaMock[other].deleteMany).not.toHaveBeenCalled();
  });

  it('stops at a short batch', async () => {
    prismaMock.moveRawResponse.findMany.mockResolvedValueOnce([{ match_id: 'm', move_index: 0 }]);
    prismaMock.moveRawResponse.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await purgeExpiredRawResponses({ now, days: 1 })).toEqual({ deleted: 1 });
    expect(prismaMock.moveRawResponse.findMany).toHaveBeenCalledTimes(1);
  });
});
