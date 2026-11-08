process.env.DATABASE_URL = 'postgres://test';

const prismaMock = {
  gameDefinition: { findUnique: jest.fn(), findMany: jest.fn() },
  match: { count: jest.fn().mockResolvedValue(0) },
  gameEngineArtifact: { findFirst: jest.fn() }
};
const createMatch = jest.fn().mockResolvedValue({ id: 'new' });
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));
jest.mock('../src/repositories/model.repository', () => ({
  ModelRepository: class { findById = jest.fn().mockResolvedValue({ id: 'x', api_provider: 'openai' }); findAll = jest.fn().mockResolvedValue([]); }
}));
jest.mock('../src/services/match.service', () => ({ MatchService: class { createMatch = createMatch; } }));
jest.mock('../src/services/game-release.service', () => ({ activateDueScheduledGames: jest.fn() }));

jest.mock('../src/services/og-image.service', () => ({ renderOgImage: jest.fn() }));

import { create } from '../src/controllers/match.controller';

const setting = (key: string, type: string, def: any, tier = 'FREE') =>
  ({ key, type, default_value: def, tier_required: tier, enum_options: [], min_value: null, max_value: null });

const gameDef = (key: string, settings: any[] = [], extra: any = {}) => ({
  key, status: 'LIVE', settings, roles: [], max_players: null, capabilities: [], engine_artifacts: [], ...extra
});

const run = async (body: any, tier = 'FREE', entitlements?: any) => {
  const res: any = { redirected: undefined as string | undefined, status: jest.fn(function (this: any) { return this; }), json: jest.fn(), render: jest.fn() };
  res.redirect = (url: string) => { res.redirected = url; };
  const req: any = { body, session: { userId: 'u1', user: { tier } }, accepts: () => 'html', entitlements };
  await create(req, res);
  return res;
};

beforeEach(() => {
  createMatch.mockClear();
  prismaMock.gameDefinition.findUnique.mockReset();
});

describe('match creation', () => {
  it('redirects back to the form with the reason instead of a bare error page', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chess'));
    const res = await run({ gameType: 'chess', model1Id: 'a' });
    expect(res.redirected).toMatch(/^\/matches\/create\?error=Select%20a%20model%20for%20black/);
    expect(createMatch).not.toHaveBeenCalled();
  });

  it('reports an unknown or unpublished game', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(null);
    expect((await run({ gameType: 'ghost' })).redirected).toMatch(/Game%20not%20found/);
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('my-game', [], { status: 'DRAFT' }));
    expect((await run({ gameType: 'my-game' })).redirected).toMatch(/draft/);
  });

  it('passes blackjack form values through, including turning double off', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('blackjack', [
      setting('starting_stack', 'INT', 1000), setting('fixed_bet', 'INT', 10), setting('allow_double', 'BOOLEAN', true)
    ], { max_players: 6 }));
    await run({
      gameType: 'blackjack', playerCount: '2', model1Id: 'a', model2Id: 'b',
      blackjack_starting_stack: '500', blackjack_fixed_bet: '25'
      // allow_double / dealer_hits_soft_17 checkboxes absent => off
    });
    const [participants, gameType, options] = createMatch.mock.calls[0];
    expect(gameType).toBe('blackjack');
    expect(participants).toEqual([{ modelId: 'a', role: 'seat1' }, { modelId: 'b', role: 'seat2' }]);
    expect(options).toMatchObject({ playerCount: 2, startingStack: 500, fixedBet: 25, allowDouble: false, dealerHitsSoft17: false });
  });

  it('applies enterprise-only blackjack options for enterprise users and strips them otherwise', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('blackjack', [setting('starting_stack', 'INT', 1000)], { max_players: 6 }));
    const body = {
      gameType: 'blackjack', playerCount: '1', model1Id: 'a', blackjack_starting_stack: '1000', blackjack_fixed_bet: '10',
      blackjack_allow_double: 'on', blackjack_deck_count: '2', blackjack_payout: '1.2', blackjack_allow_split: 'on', blackjack_dealer_peek: 'on'
    };
    await run(body, 'ENTERPRISE');
    expect(createMatch.mock.calls[0][2]).toMatchObject({ deckCount: 2, blackjackPayout: 1.2, allowSplit: true, dealerPeek: true, allowInsurance: false });
    createMatch.mockClear();
    await run(body, 'FREE');
    const free = createMatch.mock.calls[0][2];
    expect(free).not.toHaveProperty('deckCount');
    expect(free).not.toHaveProperty('allowSplit');
    expect(free).not.toHaveProperty('dealerPeek');
  });

  it('clamps player counts to the game limits', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('texas_holdem', [setting('starting_stack', 'INT', 1000)], { max_players: 6 }));
    const models = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`model${i + 1}Id`, `m${i + 1}`]));
    await run({ gameType: 'texas_holdem', playerCount: '50', ...models });
    expect(createMatch.mock.calls[0][0]).toHaveLength(6);
    createMatch.mockClear();
    await run({ gameType: 'texas_holdem', playerCount: '1', ...models });
    expect(createMatch.mock.calls[0][0]).toHaveLength(2);
  });

  it('keeps unspecified options undefined so engines use their own defaults', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chess', [setting('start_fen', 'TEXT', undefined, 'ENTERPRISE')]));
    await run({ gameType: 'chess', model1Id: 'a', model2Id: 'b' });
    const options = createMatch.mock.calls[0][2];
    expect(Object.values(options).includes(undefined)).toBe(false);
  });

  it('honours the dealer seat for poker', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('texas_holdem', [], { max_players: 6 }));
    await run({ gameType: 'texas_holdem', playerCount: '3', dealerSeat: '2', model1Id: 'a', model2Id: 'b', model3Id: 'c' });
    expect(createMatch.mock.calls[0][2]).toMatchObject({ playerCount: 3, dealerIndex: 1 });
  });

  describe('quota reservation', () => {
    const quotaEntitlements = (allowed: boolean) => {
      const release = jest.fn().mockResolvedValue(undefined);
      return {
        release,
        entitlements: {
          resolved: { 'matches.quota': true },
          entitlementValue: () => undefined,
          reserveQuota: jest.fn().mockResolvedValue({ allowed, release })
        }
      };
    };

    it('reserves atomically and keeps the unit when the match is created', async () => {
      prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chutes_and_ladders'));
      const { entitlements, release } = quotaEntitlements(true);
      await run({ gameType: 'chutes_and_ladders', model1Id: 'a' }, 'FREE', entitlements);
      expect(entitlements.reserveQuota).toHaveBeenCalledWith('matches.quota', { type: 'user', id: 'u1' });
      expect(createMatch).toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('rejects with 429 when the reservation is denied and creates nothing', async () => {
      prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chutes_and_ladders'));
      const { entitlements } = quotaEntitlements(false);
      const res = await run({ gameType: 'chutes_and_ladders', model1Id: 'a' }, 'FREE', entitlements);
      expect(res.redirected).toMatch(/quota%20exceeded/);
      expect(createMatch).not.toHaveBeenCalled();
    });

    it('gives the unit back when match creation fails', async () => {
      prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chutes_and_ladders'));
      createMatch.mockRejectedValueOnce(new Error('db down'));
      const { entitlements, release } = quotaEntitlements(true);
      await run({ gameType: 'chutes_and_ladders', model1Id: 'a' }, 'FREE', entitlements);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('does not consume quota when the form is invalid', async () => {
      prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chess'));
      const { entitlements } = quotaEntitlements(true);
      await run({ gameType: 'chess', model1Id: 'a' }, 'FREE', entitlements); // missing black
      expect(entitlements.reserveQuota).not.toHaveBeenCalled();
    });
  });

  it('turns a queue failure into a friendly redirect', async () => {
    prismaMock.gameDefinition.findUnique.mockResolvedValue(gameDef('chutes_and_ladders'));
    createMatch.mockRejectedValueOnce(new Error('The match queue is unavailable. Please try again shortly.'));
    const res = await run({ gameType: 'chutes_and_ladders', model1Id: 'a' });
    expect(res.redirected).toMatch(/queue%20is%20unavailable/);
  });
});
