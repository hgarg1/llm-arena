process.env.DATABASE_URL = 'postgres://test';
const getStatus = jest.fn();
const findEventsAfter = jest.fn();
const getMatch = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: {} }));
jest.mock('../src/repositories/match.repository', () => ({
  MatchRepository: class { getStatus = getStatus; findEventsAfter = findEventsAfter; findById = jest.fn(); findAll = jest.fn(); }
}));
jest.mock('../src/services/match.service', () => ({ MatchService: class { getMatch = getMatch; createMatch = jest.fn(); } }));
jest.mock('../src/repositories/model.repository', () => ({ ModelRepository: class {} }));
jest.mock('../src/services/game-release.service', () => ({ activateDueScheduledGames: jest.fn() }));

jest.mock('../src/services/og-image.service', () => ({ renderOgImage: jest.fn() }));

import { events } from '../src/controllers/match.controller';

const call = async (id: string, query: any = {}) => {
  const res: any = { headers: {} as Record<string, string>, statusCode: 200, body: undefined as any };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await events({ params: { id }, query } as any, res);
  return res;
};

beforeEach(() => [getStatus, findEventsAfter, getMatch].forEach(m => m.mockReset()));

describe('GET /matches/:id/events', () => {
  it('returns the whole log for a first load', async () => {
    getMatch.mockResolvedValue({ status: 'RUNNING', events: [{ seq: 0 }, { seq: 1 }] });
    const res = await call('m1');
    expect(res.body).toEqual([{ seq: 0 }, { seq: 1 }]);
    expect(findEventsAfter).not.toHaveBeenCalled();
  });

  it('returns only newer events with ?after=, without loading the whole match', async () => {
    getStatus.mockResolvedValue('RUNNING');
    findEventsAfter.mockResolvedValue([{ seq: 6 }]);
    const res = await call('m1', { after: '5' });
    expect(findEventsAfter).toHaveBeenCalledWith('m1', 5);
    expect(getMatch).not.toHaveBeenCalled();
    expect(res.body).toEqual([{ seq: 6 }]);
    expect(res.headers['X-Match-Status']).toBe('RUNNING');
  });

  it('never lets the CDN cache a running match', async () => {
    getMatch.mockResolvedValue({ status: 'RUNNING', events: [] });
    expect((await call('m1')).headers['Cache-Control']).toBe('no-store');
    getMatch.mockResolvedValue({ status: 'PENDING', events: [] });
    expect((await call('m1')).headers['Cache-Control']).toBe('no-store');
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('lets the CDN cache a %s match', async status => {
    getMatch.mockResolvedValue({ status, events: [{ seq: 0 }] });
    const res = await call('m1');
    expect(res.headers['Cache-Control']).toMatch(/public.*s-maxage=3600/);
    expect(res.headers['X-Match-Status']).toBe(status);
  });

  it('is 404 for an unknown match in both modes', async () => {
    getMatch.mockResolvedValue(null);
    expect((await call('nope')).statusCode).toBe(404);
    getStatus.mockResolvedValue(null);
    expect((await call('nope', { after: '0' })).statusCode).toBe(404);
    expect(findEventsAfter).not.toHaveBeenCalled();
  });

  it('treats a malformed or negative ?after= as a full load', async () => {
    getMatch.mockResolvedValue({ status: 'COMPLETED', events: [{ seq: 0 }] });
    for (const after of ['abc', '-3', '', undefined]) {
      expect((await call('m1', { after })).body).toEqual([{ seq: 0 }]);
    }
    expect(findEventsAfter).not.toHaveBeenCalled();
  });

  it('after=0 is a valid cursor (seq starts at 0)', async () => {
    getStatus.mockResolvedValue('RUNNING');
    findEventsAfter.mockResolvedValue([]);
    await call('m1', { after: '0' });
    expect(findEventsAfter).toHaveBeenCalledWith('m1', 0);
  });
});
