const countMock = jest.fn();
const runMatchSlice = jest.fn();
const dispatchSlice = jest.fn();
const buildRunnerDeps = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: { match: { count: (...a: any[]) => countMock(...a) } } }));
jest.mock('../src/services/match-runner.service', () => ({ runMatchSlice: (...a: any[]) => runMatchSlice(...a) }));
jest.mock('../src/services/runner/dispatch', () => ({ dispatchSlice: (...a: any[]) => dispatchSlice(...a) }));
jest.mock('../src/services/runner/default-deps', () => ({ buildRunnerDeps: (...a: any[]) => buildRunnerDeps(...a) }));

import { acceptSlice, performSlice, sliceBudgetMs } from '../src/services/runner/slice-handler';

const ID = '123e4567-e89b-12d3-a456-426614174000';
const saved = { ...process.env };

beforeEach(() => {
  process.env = { ...saved };
  delete process.env.MATCH_SLICE_MAX_DURATION_S;
  delete process.env.MATCH_RUNNER_CONCURRENCY;
  [countMock, runMatchSlice, dispatchSlice, buildRunnerDeps].forEach(m => m.mockReset());
  countMock.mockResolvedValue(0);
  buildRunnerDeps.mockResolvedValue({ moveTimeoutMs: 60_000 });
  dispatchSlice.mockResolvedValue(true);
  runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
});
afterAll(() => { process.env = saved; });

describe('performSlice', () => {
  it('gives the slice the function budget minus a safety margin as its deadline', async () => {
    runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
    await performSlice(ID, 1_000_000);
    const [matchId, , , options] = runMatchSlice.mock.calls[0];
    expect(matchId).toBe(ID);
    expect(options.deadlineAt).toBe(1_000_000 + 300_000 - 15_000);
  });

  it('honours MATCH_SLICE_MAX_DURATION_S', async () => {
    process.env.MATCH_SLICE_MAX_DURATION_S = '800';
    expect(sliceBudgetMs()).toBe(800_000);
    runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
    await performSlice(ID, 0);
    expect(runMatchSlice.mock.calls[0][3].deadlineAt).toBe(785_000);
  });

  it('chains the next slice only when the match yielded', async () => {
    runMatchSlice.mockResolvedValue({ done: false, status: 'yielded' });
    await performSlice(ID);
    expect(dispatchSlice).toHaveBeenCalledWith(ID, { continuation: true });
  });

  it.each([
    [{ done: true, status: 'completed' }],
    [{ done: true, status: 'cancelled' }],
    [{ done: true, status: 'finished' }],
    [{ done: false, status: 'busy' }],   // another runner owns it and will chain itself
    [{ done: false, status: 'lost' }]
  ])('does not chain after %j', async result => {
    runMatchSlice.mockResolvedValue(result);
    await performSlice(ID);
    expect(dispatchSlice).not.toHaveBeenCalled();
  });

  it('never throws, and does not chain, when the slice fails', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    runMatchSlice.mockRejectedValue(new Error('model unavailable'));
    await expect(performSlice(ID)).resolves.toBeUndefined();
    expect(dispatchSlice).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('shrinks the per-call timeout so one model call always fits in a short slice', async () => {
    process.env.MATCH_SLICE_MAX_DURATION_S = '60'; // window = 45s
    buildRunnerDeps.mockResolvedValue({ moveTimeoutMs: 60_000 });
    runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
    await performSlice(ID);
    expect(runMatchSlice.mock.calls[0][2].moveTimeoutMs).toBe(22_500);
  });

  it('keeps a smaller configured timeout', async () => {
    buildRunnerDeps.mockResolvedValue({ moveTimeoutMs: 30_000 });
    runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
    await performSlice(ID);
    expect(runMatchSlice.mock.calls[0][2].moveTimeoutMs).toBe(30_000);
  });
});

describe('acceptSlice', () => {
  it('rejects anything that is not a match id', async () => {
    for (const matchId of [undefined, 42, '', '../../etc', 'x'.repeat(36), `${ID}; drop`]) {
      expect((await acceptSlice({ matchId })).status).toBe(400);
    }
  });

  it('answers 202 immediately and does the work in the background', async () => {
    runMatchSlice.mockResolvedValue({ done: true, status: 'completed' });
    const waitUntil = jest.fn();
    const result = await acceptSlice({ matchId: ID }, waitUntil);
    expect(result).toEqual({ status: 202, body: { accepted: true } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    await waitUntil.mock.calls[0][0];
    expect(runMatchSlice).toHaveBeenCalledTimes(1);
  });

  it('defers a brand-new match when the concurrency cap is reached (it stays PENDING for the sweeper)', async () => {
    process.env.MATCH_RUNNER_CONCURRENCY = '3';
    countMock.mockResolvedValue(3);
    const waitUntil = jest.fn();
    const result = await acceptSlice({ matchId: ID, continuation: false }, waitUntil);
    expect(result.body).toMatchObject({ accepted: false, deferred: true, active: 3, cap: 3 });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('never defers a continuation: a running match keeps its capacity', async () => {
    process.env.MATCH_RUNNER_CONCURRENCY = '1';
    countMock.mockResolvedValue(10);
    const waitUntil = jest.fn();
    const result = await acceptSlice({ matchId: ID, continuation: true }, waitUntil);
    expect(result.body).toEqual({ accepted: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(countMock).not.toHaveBeenCalled();
  });
});
