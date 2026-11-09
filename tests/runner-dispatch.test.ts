import { dispatchSlice, runnerBaseUrl } from '../src/services/runner/dispatch';
import { verifyRunnerRequest } from '../src/services/runner/auth';
import { getRunnerMode, isRunnerEnabled } from '../src/config/runtime';

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; (globalThis as any).fetch = undefined; });

describe('runner base url', () => {
  it('prefers an explicit URL, then the production domain, then the site URL', () => {
    process.env.MATCH_RUNNER_URL = 'https://runner.example.com/';
    expect(runnerBaseUrl()).toBe('https://runner.example.com');
    delete process.env.MATCH_RUNNER_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'arena.vercel.app';
    expect(runnerBaseUrl()).toBe('https://arena.vercel.app');
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.SITE_URL = 'https://site.example.com';
    expect(runnerBaseUrl()).toBe('https://site.example.com');
  });
});

describe('dispatchSlice', () => {
  beforeEach(() => { process.env.MATCH_RUNNER_SECRET = 'shh'; process.env.MATCH_RUNNER_URL = 'https://runner.test'; });

  it('posts a signed request that the receiver can verify', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    (globalThis as any).fetch = fetchMock;
    expect(await dispatchSlice('11111111-1111-1111-1111-111111111111', { continuation: true })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://runner.test/api/internal/match-slice');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ matchId: '11111111-1111-1111-1111-111111111111', continuation: true });
    expect(verifyRunnerRequest(init.headers, '11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(init.signal).toBeDefined();
  });

  it('reports failure (without throwing) for HTTP errors, network errors and a missing secret', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    expect(await dispatchSlice('m')).toBe(false);
    (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await dispatchSlice('m')).toBe(false);
    delete process.env.MATCH_RUNNER_SECRET;
    expect(await dispatchSlice('m')).toBe(false);
    warn.mockRestore();
  });
});

describe('runner mode', () => {
  const clear = () => ['MATCH_RUNNER', 'MATCH_QUEUE_ENABLED', 'REDIS_URL'].forEach(k => delete process.env[k]);

  it('is none by default (nothing runs matches), preserving old behaviour', () => {
    clear();
    expect(getRunnerMode()).toBe('none');
    expect(isRunnerEnabled()).toBe(false);
  });

  it('keeps using BullMQ when only the queue is configured', () => {
    clear();
    process.env.MATCH_QUEUE_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://x';
    expect(getRunnerMode()).toBe('bullmq');
  });

  it('vercel and inline need no Redis', () => {
    clear();
    process.env.MATCH_RUNNER = 'vercel';
    expect(getRunnerMode()).toBe('vercel');
    process.env.MATCH_RUNNER = 'INLINE';
    expect(getRunnerMode()).toBe('inline');
  });

  it('bullmq without Redis is none, and unknown values are ignored', () => {
    clear();
    process.env.MATCH_RUNNER = 'bullmq';
    expect(getRunnerMode()).toBe('none');
    process.env.MATCH_RUNNER = 'lambda';
    expect(getRunnerMode()).toBe('none');
  });
});
