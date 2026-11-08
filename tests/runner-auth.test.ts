import { signRunnerRequest, verifyCronRequest, verifyRunnerRequest } from '../src/services/runner/auth';

const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const saved = { ...process.env };
  Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try { fn(); } finally { process.env = saved; }
};

describe('runner request signing', () => {
  it('accepts a freshly signed request for the same subject', () => {
    withEnv({ MATCH_RUNNER_SECRET: 's3cret' }, () => {
      expect(verifyRunnerRequest(signRunnerRequest('match-1'), 'match-1')).toBe(true);
    });
  });

  it('rejects a different subject, a tampered signature, and another secret', () => {
    withEnv({ MATCH_RUNNER_SECRET: 's3cret' }, () => {
      const headers = signRunnerRequest('match-1');
      expect(verifyRunnerRequest(headers, 'match-2')).toBe(false);
      expect(verifyRunnerRequest({ ...headers, 'x-runner-signature': headers['x-runner-signature'].replace(/.$/, c => (c === '0' ? '1' : '0')) }, 'match-1')).toBe(false);
      process.env.MATCH_RUNNER_SECRET = 'other';
      expect(verifyRunnerRequest(headers, 'match-1')).toBe(false);
    });
  });

  it('rejects stale and future timestamps (replay protection)', () => {
    withEnv({ MATCH_RUNNER_SECRET: 's3cret' }, () => {
      const now = Date.now();
      expect(verifyRunnerRequest(signRunnerRequest('m', now - 6 * 60_000), 'm', now)).toBe(false);
      expect(verifyRunnerRequest(signRunnerRequest('m', now + 6 * 60_000), 'm', now)).toBe(false);
      expect(verifyRunnerRequest(signRunnerRequest('m', now - 60_000), 'm', now)).toBe(true);
    });
  });

  it('fails closed without a secret or without headers', () => {
    withEnv({ MATCH_RUNNER_SECRET: 's3cret' }, () => {
      const headers = signRunnerRequest('m');
      expect(verifyRunnerRequest({}, 'm')).toBe(false);
      expect(verifyRunnerRequest({ 'x-runner-timestamp': headers['x-runner-timestamp'] }, 'm')).toBe(false);
      delete process.env.MATCH_RUNNER_SECRET;
      expect(verifyRunnerRequest(headers, 'm')).toBe(false);
      expect(() => signRunnerRequest('m')).toThrow(/not configured/);
    });
  });

  it('accepts header arrays (as some proxies deliver them)', () => {
    withEnv({ MATCH_RUNNER_SECRET: 's3cret' }, () => {
      const headers = signRunnerRequest('m');
      expect(verifyRunnerRequest({ 'x-runner-timestamp': [headers['x-runner-timestamp']], 'x-runner-signature': [headers['x-runner-signature']] }, 'm')).toBe(true);
    });
  });

  it('cron requests must carry the exact bearer secret', () => {
    withEnv({ CRON_SECRET: 'cron-secret' }, () => {
      expect(verifyCronRequest({ authorization: 'Bearer cron-secret' })).toBe(true);
      expect(verifyCronRequest({ authorization: 'Bearer nope' })).toBe(false);
      expect(verifyCronRequest({ authorization: 'cron-secret' })).toBe(false);
      expect(verifyCronRequest({})).toBe(false);
    });
    withEnv({ CRON_SECRET: undefined }, () => {
      expect(verifyCronRequest({ authorization: 'Bearer undefined' })).toBe(false);
      expect(verifyCronRequest({ authorization: 'Bearer ' })).toBe(false);
    });
  });
});
