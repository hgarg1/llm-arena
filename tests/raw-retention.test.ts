const prismaMock: any = { moveRawResponse: { findMany: jest.fn(), deleteMany: jest.fn() }, match: { deleteMany: jest.fn() }, matchMove: { deleteMany: jest.fn() }, matchManifest: { deleteMany: jest.fn() } };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));

import { purgeExpiredRawResponses, rawRetentionDays } from '../src/services/raw-retention.service';

const saved = process.env.INTEGRITY_RAW_RETENTION_DAYS;
const now = new Date('2026-11-09T12:00:00.000Z');
beforeEach(() => {
  delete process.env.INTEGRITY_RAW_RETENTION_DAYS;
  prismaMock.moveRawResponse.findMany.mockReset().mockResolvedValue([]);
  prismaMock.moveRawResponse.deleteMany.mockReset().mockResolvedValue({ count: 0 });
});
afterAll(() => { if (saved === undefined) delete process.env.INTEGRITY_RAW_RETENTION_DAYS; else process.env.INTEGRITY_RAW_RETENTION_DAYS = saved; });

describe('raw response retention', () => {
  it('keeps responses for 90 days by default, and the setting overrides it', () => {
    expect(rawRetentionDays()).toBe(90);
    process.env.INTEGRITY_RAW_RETENTION_DAYS = '30';
    expect(rawRetentionDays()).toBe(30);
    for (const bad of ['abc', '-5', 'NaN']) { process.env.INTEGRITY_RAW_RETENTION_DAYS = bad; expect(rawRetentionDays()).toBe(90); }
  });

  it('only deletes responses older than the window', async () => {
    await purgeExpiredRawResponses({ now, days: 90 });
    const cutoff = prismaMock.moveRawResponse.findMany.mock.calls[0][0].where.created_at.lt as Date;
    expect(cutoff.toISOString()).toBe('2026-08-11T12:00:00.000Z');
  });

  it('0 days means keep forever: nothing is read or deleted', async () => {
    expect(await purgeExpiredRawResponses({ now, days: 0 })).toEqual({ deleted: 0 });
    process.env.INTEGRITY_RAW_RETENTION_DAYS = '0';
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
