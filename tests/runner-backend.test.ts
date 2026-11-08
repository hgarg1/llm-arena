const queueAdd = jest.fn();
const runMatch = jest.fn();
const dispatchSlice = jest.fn();
const buildRunnerDeps = jest.fn();
jest.mock('../src/services/queue', () => ({ matchQueue: { add: (...a: any[]) => queueAdd(...a) } }));
jest.mock('../src/services/settings.service', () => ({ settingsService: { getAll: async () => ({ queue_retry_attempts: '4', queue_retry_backoff_ms: '250' }) } }));
jest.mock('../src/services/match-runner.service', () => ({ runMatch: (...a: any[]) => runMatch(...a) }));
jest.mock('../src/services/runner/dispatch', () => ({ dispatchSlice: (...a: any[]) => dispatchSlice(...a) }));
jest.mock('../src/services/runner/default-deps', () => ({ buildRunnerDeps: (...a: any[]) => buildRunnerDeps(...a) }));

import { startMatch } from '../src/services/runner/backend';

const saved = { ...process.env };
beforeEach(() => {
  process.env = { ...saved };
  ['MATCH_RUNNER', 'MATCH_QUEUE_ENABLED', 'REDIS_URL'].forEach(k => delete process.env[k]);
  [queueAdd, runMatch, dispatchSlice, buildRunnerDeps].forEach(m => m.mockReset());
  dispatchSlice.mockResolvedValue(true);
  buildRunnerDeps.mockResolvedValue({ deps: true });
  runMatch.mockResolvedValue({ done: true });
});
afterAll(() => { process.env = saved; });

describe('startMatch', () => {
  it('vercel: dispatches the first slice as a new match, and never throws if dispatch fails', async () => {
    process.env.MATCH_RUNNER = 'vercel';
    await startMatch('m1', { a: 1 });
    expect(dispatchSlice).toHaveBeenCalledWith('m1', { continuation: false });
    expect(queueAdd).not.toHaveBeenCalled();
    dispatchSlice.mockResolvedValue(false); // the sweeper will pick it up within a minute
    await expect(startMatch('m2')).resolves.toBeUndefined();
  });

  it('bullmq: enqueues with the configured retry policy and propagates queue failures', async () => {
    process.env.MATCH_QUEUE_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://x';
    await startMatch('m1', { a: 1 });
    expect(queueAdd).toHaveBeenCalledWith('run-match', { matchId: 'm1', options: { a: 1 } }, { attempts: 4, backoff: { type: 'fixed', delay: 250 } });
    queueAdd.mockRejectedValue(new Error('redis down'));
    await expect(startMatch('m2')).rejects.toThrow('redis down');
  });

  it('inline: runs the match in this process, later, without blocking the caller', async () => {
    process.env.MATCH_RUNNER = 'inline';
    await startMatch('m1', { a: 1 });
    expect(runMatch).not.toHaveBeenCalled();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(runMatch).toHaveBeenCalledWith('m1', { a: 1 }, { deps: true });
  });

  it('inline: a failing run is logged, not thrown into the process', async () => {
    process.env.MATCH_RUNNER = 'inline';
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    runMatch.mockRejectedValue(new Error('engine exploded'));
    await startMatch('m1');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('none: does nothing', async () => {
    await startMatch('m1');
    expect([dispatchSlice, queueAdd, runMatch].every(m => m.mock.calls.length === 0)).toBe(true);
  });
});
