const queryRaw = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: { $queryRaw: (...a: any[]) => queryRaw(...a) } }));

import { createDbRateLimiter, limitsFor, takeFromBucket } from '../src/services/rate-limit.service';

const saved = { ...process.env };
beforeEach(() => {
  process.env = { ...saved };
  Object.keys(process.env).filter(k => k.startsWith('PROVIDER_')).forEach(k => delete process.env[k]);
  queryRaw.mockReset();
});
afterAll(() => { process.env = saved; });

const sqlOf = (call: any[]) => (call[0] as TemplateStringsArray).join('?');

describe('limitsFor', () => {
  it('reads per-provider requests and tokens per minute from the environment', () => {
    process.env.PROVIDER_RPM_OPENAI = '500';
    process.env.PROVIDER_TPM_OPENAI = '200000';
    expect(limitsFor('openai')).toEqual({ rpm: 500, tpm: 200000 });
  });

  it('normalises provider names (z.ai, xai) and treats junk or missing values as unlimited', () => {
    process.env['PROVIDER_RPM_Z_AI'] = '60';
    expect(limitsFor('z.ai').rpm).toBe(60);
    process.env.PROVIDER_RPM_XAI = 'lots';
    process.env.PROVIDER_TPM_XAI = '-5';
    expect(limitsFor('xai')).toEqual({ rpm: null, tpm: null });
    expect(limitsFor('anthropic')).toEqual({ rpm: null, tpm: null });
  });
});

describe('createDbRateLimiter', () => {
  it('does no database work for a provider with no configured limits', async () => {
    expect(await createDbRateLimiter().acquire('anthropic', 5000)).toEqual({ allowed: true });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('takes one request and the estimated tokens from separate buckets', async () => {
    process.env.PROVIDER_RPM_OPENAI = '600';
    process.env.PROVIDER_TPM_OPENAI = '120000';
    queryRaw.mockResolvedValue([{ tokens: 1 }]);
    expect(await createDbRateLimiter().acquire('openai', 4000)).toEqual({ allowed: true });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const values = queryRaw.mock.calls.map(c => c.slice(1));
    expect(values[0][0]).toBe('openai:rpm');
    expect(values[1][0]).toBe('openai:tpm');
    expect(values[1]).toContain(4000);
  });

  it('stops at the first denied bucket and reports how long to wait', async () => {
    process.env.PROVIDER_RPM_OPENAI = '60';
    process.env.PROVIDER_TPM_OPENAI = '100000';
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ available: 0 }]);
    const result: any = await createDbRateLimiter().acquire('openai', 100);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(1000); // 60/min is 1/s, so one request takes 1s to refill
    expect(queryRaw).toHaveBeenCalledTimes(2); // the token bucket was never touched
  });

  it('the bucket SQL refills by elapsed time and only takes when enough is available', async () => {
    process.env.PROVIDER_RPM_OPENAI = '60';
    queryRaw.mockResolvedValue([{ tokens: 4 }]);
    await createDbRateLimiter().acquire('openai', 1);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(sql).toMatch(/ON CONFLICT \("key"\) DO UPDATE/);
    expect(sql).toMatch(/LEAST\(/);
    expect(sql).toMatch(/EXTRACT\(EPOCH FROM \(now\(\) - "ProviderRateLimit"\.updated_at\)\)/);
    expect(sql).toMatch(/WHERE LEAST\(.*>=/s);
    expect(sql).toMatch(/RETURNING tokens/);
  });
});

describe('takeFromBucket', () => {
  it('never asks for more than the bucket can hold (a huge prompt must still be admissible)', async () => {
    queryRaw.mockResolvedValue([{ tokens: 0 }]);
    await takeFromBucket('openai:tpm', 6000, 50_000); // capacity is 5s of 6000/min = 500
    const values = queryRaw.mock.calls[0].slice(1);
    expect(Math.max(...values.filter((v: unknown) => typeof v === 'number'))).toBeLessThanOrEqual(6000);
    expect(values).toContain(500); // capacity used as the take
  });

  it('retryAfter is never below 50 ms', async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ available: 0.9999 }]);
    const result: any = await takeFromBucket('k', 6000, 1);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(50);
  });
});
