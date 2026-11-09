process.env.DATABASE_URL = 'postgres://test';
const findAll = jest.fn();
const getMatch = jest.fn();
const verifyStoredMatch = jest.fn();
const prismaMock = { gameDefinition: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) }, match: { findMany: jest.fn().mockResolvedValue([]) } };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));
jest.mock('../src/repositories/match.repository', () => ({
  MatchRepository: class { findAll = findAll; getStatus = jest.fn(); findEventsAfter = jest.fn(); findById = jest.fn(); }
}));
jest.mock('../src/services/match.service', () => ({ MatchService: class { getMatch = getMatch; createMatch = jest.fn(); } }));
jest.mock('../src/repositories/model.repository', () => ({ ModelRepository: class {} }));
jest.mock('../src/services/game-release.service', () => ({ activateDueScheduledGames: jest.fn() }));
jest.mock('../src/services/og-image.service', () => ({ renderOgImage: jest.fn() }));
jest.mock('../src/services/match-verification.service', () => ({ verifyStoredMatch }));

import { detail, list } from '../src/controllers/match.controller';

const call = async (fn: any, req: any) => {
  const res: any = { rendered: undefined as any, status: jest.fn(function (this: any) { return this; }), send: jest.fn() };
  res.render = (view: string, data: any) => { res.rendered = { view, data }; };
  await fn({ params: {}, query: {}, ...req }, res);
  return res;
};

beforeEach(() => {
  findAll.mockReset().mockResolvedValue({ matches: [], total: 0, page: 1, limit: 20, totalPages: 0 });
  getMatch.mockReset();
  verifyStoredMatch.mockReset();
});

describe('GET /matches verification filter', () => {
  it.each(['signed', 'unverified'])('passes ?verification=%s to the repository and back to the page', async value => {
    const res = await call(list, { query: { verification: value } });
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ verification: value }));
    expect(res.rendered.data.query.verification).toBe(value);
  });

  it.each([undefined, '', 'all', 'verified', "signed' OR '1'='1", ['signed', 'unverified']])('ignores %p (no filter)', async value => {
    const res = await call(list, { query: { verification: value } });
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ verification: undefined }));
    expect(res.rendered.data.query.verification).toBe('');
  });

  it('a filtered list is not indexed or canonicalised as a separate page', async () => {
    const res = await call(list, { query: { verification: 'signed' } });
    expect(res.rendered.data.seo.canonicalPath).toBe('/matches');
    expect(res.rendered.data.seo.robots).toMatch(/noindex/);
  });

  it('combines with the other filters instead of replacing them', async () => {
    await call(list, { query: { verification: 'unverified', game: 'chess', status: 'COMPLETED', q: 'gpt', page: '2' } });
    expect(findAll).toHaveBeenCalledWith({ page: 2, search: 'gpt', gameType: 'chess', status: 'COMPLETED', verification: 'unverified' });
  });
});

describe('GET /matches/:id verification', () => {
  const match = { id: 'm1', game_type: 'chess', status: 'COMPLETED', events: [], participants: [] };
  const open = () => call(detail, { params: { id: 'm1' } });

  it.each([
    [{ state: 'verified' }],
    [{ state: 'unverified' }],
    [{ state: 'failed', code: 'HEAD_MISMATCH' }],
    [{ state: 'in-progress' }]
  ])('hands the verification result %p to the page unchanged', async result => {
    getMatch.mockResolvedValue(match);
    verifyStoredMatch.mockResolvedValue(result);
    const res = await open();
    expect(verifyStoredMatch).toHaveBeenCalledWith('m1');
    expect(res.rendered.view).toBe('matches/detail');
    expect(res.rendered.data.verification).toEqual(result);
  });

  it('if the check itself cannot run, the page says so; it never shows verified', async () => {
    getMatch.mockResolvedValue(match);
    verifyStoredMatch.mockRejectedValue(new Error('db down'));
    const res = await open();
    expect(res.rendered.data.verification).toEqual({ state: 'failed', code: 'CHECK_UNAVAILABLE' });
  });

  it('does not verify a match that does not exist', async () => {
    getMatch.mockResolvedValue(null);
    await open();
    expect(verifyStoredMatch).not.toHaveBeenCalled();
  });
});
