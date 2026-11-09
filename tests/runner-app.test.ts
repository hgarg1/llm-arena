const acceptSlice = jest.fn();
const sweepMatches = jest.fn();
jest.mock('../src/services/runner/slice-handler', () => ({ acceptSlice: (...a: any[]) => acceptSlice(...a) }));
jest.mock('../src/services/runner/sweeper', () => ({ sweepMatches: (...a: any[]) => sweepMatches(...a) }));

const logMetric = jest.fn();
jest.mock('../src/services/metrics.service', () => ({ logMetric: (...a: any[]) => logMetric(...a) }));

import http from 'http';
import { AddressInfo } from 'net';
import { createRunnerApp } from '../src/runner-app';
import { signRunnerRequest } from '../src/services/runner/auth';

const saved = { ...process.env };
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(createRunnerApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = saved; await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  process.env.MATCH_RUNNER_SECRET = 'shh';
  process.env.CRON_SECRET = 'cron';
  acceptSlice.mockReset().mockResolvedValue({ status: 202, body: { accepted: true } });
  sweepMatches.mockReset().mockResolvedValue({ resumed: 1, started: 2, expired: 0, active: 3, cap: 50 });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('internal runner API', () => {
  it('rejects unsigned and wrongly signed slice requests without doing any work', async () => {
    expect((await post('/api/internal/match-slice', { matchId: 'abc' })).status).toBe(401);
    expect((await post('/api/internal/match-slice', { matchId: 'abc' }, signRunnerRequest('other'))).status).toBe(401);
    expect(acceptSlice).not.toHaveBeenCalled();
  });

  it('fails closed when no secret is configured', async () => {
    const headers = signRunnerRequest('abc');
    delete process.env.MATCH_RUNNER_SECRET;
    expect((await post('/api/internal/match-slice', { matchId: 'abc' }, headers)).status).toBe(401);
  });

  it('accepts a correctly signed slice request and returns the handler result', async () => {
    const res = await post('/api/internal/match-slice', { matchId: 'abc', continuation: true }, signRunnerRequest('abc'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(acceptSlice).toHaveBeenCalledWith({ matchId: 'abc', continuation: true });
  });

  it('reports handler errors as 500 without leaking details', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    acceptSlice.mockRejectedValue(new Error('secret db password in message'));
    const res = await post('/api/internal/match-slice', { matchId: 'abc' }, signRunnerRequest('abc'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('password');
    error.mockRestore();
  });

  it('the sweep accepts the cron bearer secret (GET, as Vercel Cron calls it)', async () => {
    const res = await fetch(`${base}/api/internal/sweep`, { headers: { authorization: 'Bearer cron' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resumed: 1, started: 2 });
    expect(logMetric).toHaveBeenCalledWith('runner.sweep', expect.objectContaining({ resumed: 1, started: 2, cap: 50 })); // so the cron job is visible in the logs
  });

  it('the sweep also accepts a signed request, and rejects everything else', async () => {
    expect((await post('/api/internal/sweep', {}, signRunnerRequest('sweep'))).status).toBe(200);
    expect((await fetch(`${base}/api/internal/sweep`)).status).toBe(401);
    expect((await fetch(`${base}/api/internal/sweep`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await post('/api/internal/sweep', {}, signRunnerRequest('match-slice'))).status).toBe(401);
    expect(sweepMatches).toHaveBeenCalledTimes(1);
  });

  it('exposes nothing else (the website lives in a different function)', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });

  it('refuses oversized bodies', async () => {
    const res = await post('/api/internal/match-slice', { matchId: 'x'.repeat(50_000) }, signRunnerRequest('x'));
    expect(res.status).toBe(413);
  });
});
