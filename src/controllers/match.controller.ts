import { Request, Response } from 'express';
import { MatchService } from '../services/match.service';
import { ModelRepository } from '../repositories/model.repository';
import { MatchRepository } from '../repositories/match.repository';
import { MatchStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { isDatabaseConfigured, isRunnerEnabled } from '../config/runtime';
import { BUILT_IN_GAME_KEYS } from '../services/game-engine-artifact.service';
import { activateDueScheduledGames } from '../services/game-release.service';
import {
  buildAbsoluteUrl,
  buildBreadcrumbSchema,
  buildMatchDescription,
  buildSeo,
  buildWebPageSchema
} from '../services/seo.service';
import { renderOgImage } from '../services/og-image.service';
import { mapOptionsToEngine } from '../game/options';

const reject = (req: Request, res: Response, status: number, message: string) => {
  if (req.accepts(['html', 'json']) === 'json') return res.status(status).json({ error: message });
  return res.redirect(`/matches/create?error=${encodeURIComponent(message)}`);
};

const clampInt = (value: any, min: number, max: number, fallback: number) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const matchService = new MatchService();
const modelRepo = new ModelRepository();
const matchRepo = new MatchRepository();
const USER_VISIBLE_BUILT_IN_GAME_KEYS = Array.from(BUILT_IN_GAME_KEYS).filter(key => key !== 'iterated-negotiation');

const normalizeList = (value: any) => {
  if (!value) return { allowlist: [], denylist: [], matchMode: 'exact' };
  if (Array.isArray(value)) return { allowlist: value, denylist: [], matchMode: 'exact' };
  if (typeof value === 'object') {
    return {
      allowlist: Array.isArray(value.allowlist) ? value.allowlist : [],
      denylist: Array.isArray(value.denylist) ? value.denylist : [],
      matchMode: value.match_mode || 'exact'
    };
  }
  return { allowlist: [], denylist: [], matchMode: 'exact' };
};

const isAllowed = (value: string, allowlist: string[], denylist: string[], matchMode: string) => {
  const matches = (item: string) => (matchMode === 'prefix' ? value.startsWith(item) : value === item);
  if (denylist.some(matches)) return false;
  if (allowlist.length === 0) return true;
  return allowlist.some(matches);
};

const filterModelsByEntitlements = (models: any[], entitlements: any) => {
  if (!entitlements || !entitlements.entitlementValue) return models;
  const providerPolicy = normalizeList(entitlements.entitlementValue('models.allowed_providers'));
  const idPolicy = normalizeList(entitlements.entitlementValue('models.allowed_ids'));
  const denyPolicy = normalizeList(entitlements.entitlementValue('models.denied_ids'));
  return models.filter(model => {
    const providerAllowed = isAllowed(String(model.api_provider || ''), providerPolicy.allowlist, providerPolicy.denylist, providerPolicy.matchMode);
    const idAllowed = isAllowed(String(model.id), idPolicy.allowlist, idPolicy.denylist, idPolicy.matchMode);
    const denyBlocked = denyPolicy.denylist.length > 0 && isAllowed(String(model.id), [], denyPolicy.denylist, denyPolicy.matchMode);
    return providerAllowed && idAllowed && !denyBlocked;
  });
};

const getGameDefaults = async (gameKey: string) => {
  await activateDueScheduledGames();

  if (gameKey === 'iterated-negotiation') {
    return {
      exists: true,
      status: 'LIVE',
      isPlayable: true,
      settings: {},
      tiers: {},
      list: [],
      roles: [],
      maxPlayers: null,
      capabilities: []
    };
  }

  const game = await prisma.gameDefinition.findUnique({
    where: { key: gameKey },
    include: {
      settings: true,
      engine_artifacts: {
        where: { status: 'PUBLISHED' },
        orderBy: { created_at: 'desc' },
        take: 1
      }
    }
  });
  if (!game) {
    return {
      exists: false,
      status: 'DRAFT',
      isPlayable: false,
      settings: {},
      tiers: {},
      list: [],
      roles: [],
      maxPlayers: null,
      capabilities: []
    };
  }
  const settings: Record<string, any> = {};
  const tiers: Record<string, string> = {};
  game.settings.forEach(setting => {
    settings[setting.key] = setting.default_value === null ? undefined : setting.default_value;
    tiers[setting.key] = setting.tier_required;
  });
  const isBuiltIn = USER_VISIBLE_BUILT_IN_GAME_KEYS.includes(game.key);
  return {
    exists: true,
    status: game.status,
    isPlayable: game.status === 'LIVE' && (isBuiltIn || game.engine_artifacts.length > 0),
    settings,
    tiers,
    list: game.settings,
    roles: game.roles || [],
    maxPlayers: game.max_players,
    capabilities: game.capabilities || []
  };
};

const parseGameOptions = (raw: any, settings: { key: string; type: string; enum_options: string[] | null; min_value: any; max_value: any; tier_required: string }[], userTier: string) => {
  const parsed: Record<string, any> = {};
  let input: Record<string, any> = {};
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  } else if (typeof raw === 'object' && raw) {
    input = raw;
  }

  const coerce = (type: string, value: any) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (type === 'INT') return parseInt(value, 10);
    if (type === 'FLOAT') return parseFloat(value);
    if (type === 'BOOLEAN') return value === true || value === 'true';
    return String(value);
  };

  const tierRank = (tier: string) => (tier === 'ENTERPRISE' ? 3 : tier === 'PRO' ? 2 : 1);
  settings.forEach(setting => {
    if (!(setting.key in input)) return;
    if (tierRank(userTier) < tierRank(setting.tier_required || 'FREE')) return;
    const value = coerce(setting.type, input[setting.key]);
    if (value === undefined) return;
    if (setting.type === 'ENUM') {
      const options = (setting.enum_options || []).map(opt => String(opt));
      if (options.length > 0 && !options.includes(String(value))) return;
    }
    if (setting.type === 'INT' || setting.type === 'FLOAT') {
      const minVal = setting.min_value !== null && setting.min_value !== undefined ? Number(setting.min_value) : null;
      const maxVal = setting.max_value !== null && setting.max_value !== undefined ? Number(setting.max_value) : null;
      const num = Number(value);
      if (!Number.isNaN(num)) {
        if (minVal !== null && num < minVal) return;
        if (maxVal !== null && num > maxVal) return;
      }
    }
    parsed[setting.key] = value;
  });

  return parsed;
};

export const list = async (req: Request, res: Response) => {
  const rawPage = parseInt(req.query.page as string, 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = req.query.q as string;
  const gameType = req.query.game as string;
  const status = req.query.status as MatchStatus;
  const queue = req.query.queue as string;
  const hasFilters = Boolean(search || gameType || status);
  const canonicalPath = hasFilters ? '/matches' : (page > 1 ? `/matches?page=${page}` : '/matches');
  const seo = buildSeo({
    title: hasFilters ? 'Match Search' : (page > 1 ? `Matches - Page ${page}` : 'Matches'),
    description: hasFilters
      ? 'Browse filtered public match replays and completed evaluations in LLM Arena.'
      : 'Browse public matches, replay outputs, and completed evaluation runs across games in LLM Arena.',
    canonicalPath,
    robots: hasFilters ? 'noindex,follow' : 'index,follow',
    ogImageUrl: buildAbsoluteUrl('/og/page/matches.png'),
    structuredData: [
      buildWebPageSchema(
        hasFilters ? 'Match Search' : (page > 1 ? `Matches - Page ${page}` : 'Matches'),
        hasFilters
          ? 'Browse filtered public match replays and completed evaluations in LLM Arena.'
          : 'Browse public matches, replay outputs, and completed evaluation runs across games in LLM Arena.',
        canonicalPath
      ),
      buildBreadcrumbSchema([
        { name: 'Home', path: '/' },
        { name: 'Matches', path: '/matches' }
      ])
    ]
  });

  if (!isDatabaseConfigured()) {
    return res.render('matches/list', {
      title: 'Matches',
      seo,
      matches: [],
      pagination: { page: 1, totalPages: 0, total: 0 },
      query: { search: '', gameType: '', status: '', queue: '' },
      games: [],
      statuses: Object.values(MatchStatus),
      queueEnabled: isRunnerEnabled(),
      path: '/matches'
    });
  }

  const toTitle = (value: string) =>
    value
      .split(/[_-]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');

  const [result, games, matchGameTypes] = await Promise.all([
    matchRepo.findAll({ page, search, gameType, status }),
    prisma.gameDefinition.findMany({
      orderBy: { name: 'asc' },
      select: { key: true, name: true }
    }),
    prisma.match.findMany({
      distinct: ['game_type'],
      select: { game_type: true },
      orderBy: { game_type: 'asc' }
    })
  ]);
  const statuses = Object.values(MatchStatus);
  const gameMap = new Map(games.map(game => [game.key, game.name]));
  matchGameTypes.forEach(entry => {
    if (!gameMap.has(entry.game_type)) {
      gameMap.set(entry.game_type, toTitle(entry.game_type));
    }
  });
  const gameOptions = Array.from(gameMap.entries()).map(([key, name]) => ({ key, name }));
  
  res.render('matches/list', { 
      title: 'Matches', 
      seo,
      matches: result.matches, 
      pagination: {
          page: result.page,
          totalPages: result.totalPages,
          total: result.total
      },
      query: { search, gameType, status, queue },
      games: gameOptions,
      statuses,
      queueEnabled: isRunnerEnabled(),
      path: '/matches'
  });
};

export const createPage = async (req: Request, res: Response) => {
  const seo = buildSeo({
    title: 'Create Match',
    description: 'Configure a new evaluation match in LLM Arena.',
    canonicalPath: '/matches/create',
    robots: 'noindex,follow',
    ogImageUrl: buildAbsoluteUrl('/og/page/matches.png')
  });
  if (!isDatabaseConfigured()) {
    return res.render('matches/create', {
      title: 'Create Match',
      seo,
      models: [],
      path: '/matches/create',
      gameDefaults: {},
      gameCatalog: {},
      error: req.query.error,
      queueEnabled: isRunnerEnabled()
    });
  }

  const rawModels = await modelRepo.findAll();
  const entitlements = (req as any).entitlements;
  const models = filterModelsByEntitlements(rawModels, entitlements);
  await activateDueScheduledGames();
  const gameDefinitions = await prisma.gameDefinition.findMany({
    where: { status: 'LIVE' },
    include: {
      settings: true,
      ui_schema: true,
      engine_artifacts: {
        where: { status: 'PUBLISHED' },
        orderBy: { created_at: 'desc' },
        take: 1
      }
    }
  });
  const visibleGames = gameDefinitions.filter(game =>
    USER_VISIBLE_BUILT_IN_GAME_KEYS.includes(game.key) || game.engine_artifacts.length > 0
  );
  const gameDefaults = visibleGames.reduce<Record<string, any>>((acc, game) => {
    acc[game.key] = {
      settings: game.settings.reduce<Record<string, any>>((map, setting) => {
        map[setting.key] = setting.default_value === null ? undefined : setting.default_value;
        return map;
      }, {})
    };
    return acc;
  }, {});
  const gameCatalog = visibleGames.reduce<Record<string, any>>((acc, game) => {
    acc[game.key] = {
      name: game.name,
      capabilities: game.capabilities,
      roles: game.roles,
      max_players: game.max_players,
      settings: game.settings,
      ui_schema: game.ui_schema
    };
    return acc;
  }, {});
  res.render('matches/create', {
    title: 'Create Match',
    seo,
    models,
    path: '/matches/create',
    gameDefaults,
    gameCatalog,
    error: req.query.error,
    queueEnabled: isRunnerEnabled()
  });
};

export const create = async (req: Request, res: Response) => {
  if (!isDatabaseConfigured()) {
    return res.status(503).render('errors/503');
  }

  const { playerCount, dealerSeat } = req.body;
  const gameType: string = req.body.gameType || 'iterated-negotiation';
  const participants: { modelId: string; role: string }[] = [];
  let options: any = {};
  const entitlements = (req as any).entitlements;
  const userId = (req.session as any).userId;
  const orgId = (req.session as any).user?.org_id;
  const userTier = (req.session as any).user?.tier;
  const advancedAllowed = userTier === 'ENTERPRISE';
  const defaults = await getGameDefaults(gameType);
  if (!defaults.exists) {
    return reject(req, res, 404, 'Game not found.');
  }
  if (!defaults.isPlayable) {
    return reject(req, res, 409, 'This game is still a draft or does not have a published runtime yet.');
  }
  const defaultSettings = defaults.settings as Record<string, any>;
  const gameOptions = parseGameOptions(req.body.game_options, defaults.list, userTier || 'FREE');
  const mergedOptions = { ...defaultSettings, ...gameOptions };
  const engineOptions = mapOptionsToEngine(gameType, mergedOptions);

  const concurrencyLimit = entitlements?.entitlementValue?.('matches.concurrent');
  if (typeof concurrencyLimit === 'number' && concurrencyLimit > 0 && userId) {
    const activeCount = await prisma.match.count({
      where: {
        created_by_id: userId,
        status: { in: ['PENDING', 'RUNNING'] }
      }
    });
    if (activeCount >= concurrencyLimit) {
      return reject(req, res, 429, 'Concurrent match limit reached.');
    }
  }

  const validateModelAccess = async (modelId: string) => {
    if (!entitlements) return true;
    const model = await modelRepo.findById(modelId);
    if (!model) return false;
    const filtered = filterModelsByEntitlements([model], entitlements);
    return filtered.length === 1;
  };

  const configuredRoles = Array.isArray(defaults.roles)
    ? defaults.roles.map(role => String(role).trim()).filter(Boolean)
    : [];
  const configuredMaxPlayers = typeof defaults.maxPlayers === 'number' && defaults.maxPlayers > 0
    ? defaults.maxPlayers
    : null;
  const resolvedPlayerCount = Math.max(
    1,
    Math.min(
      9,
      configuredRoles.length || configuredMaxPlayers || (gameType === 'chutes_and_ladders' ? 1 : 2)
    )
  );
  const seatLimit = Math.min(configuredMaxPlayers ?? 6, 9);

  const pickModels = async (count: number, roleFor: (i: number) => string) => {
    for (let i = 1; i <= count; i++) {
      const modelId = req.body[`model${i}Id`];
      const role = roleFor(i);
      if (!modelId) return `Select a model for ${role}`;
      if (!(await validateModelAccess(modelId))) return 'Model not permitted by your entitlements.';
      participants.push({ modelId, role });
    }
    return null;
  };

  let problem: string | null = null;
  if (gameType === 'chutes_and_ladders') {
    problem = await pickModels(1, () => 'player1');
    options = { ...options, ...engineOptions };
  } else if (gameType === 'texas_holdem') {
    const count = clampInt(playerCount, 2, seatLimit, 2);
    problem = await pickModels(count, i => `seat${i}`);
    options.playerCount = count;
    options = { ...options, ...engineOptions };
    if (dealerSeat && dealerSeat !== 'random') {
      options.dealerIndex = clampInt(dealerSeat, 1, count, 1) - 1;
    }
  } else if (gameType === 'blackjack') {
    const count = clampInt(playerCount, 1, seatLimit, 1);
    problem = await pickModels(count, i => `seat${i}`);
    options.playerCount = count;
    options = { ...options, ...engineOptions };

    // The create form posts blackjack settings as individual fields; they take precedence over defaults.
    const body = req.body;
    if (body.blackjack_starting_stack !== undefined) {
      const startingStack = clampInt(body.blackjack_starting_stack, 1, 100000, options.startingStack ?? 1000);
      options.startingStack = startingStack;
      options.fixedBet = Math.min(clampInt(body.blackjack_fixed_bet, 1, 5000, options.fixedBet ?? 10), startingStack);
      options.dealerHitsSoft17 = body.blackjack_dealer_hits_soft_17 === 'on' || body.blackjack_dealer_hits_soft_17 === 'true';
      // Checkboxes are only submitted when ticked, so absence means "off".
      options.allowDouble = body.blackjack_allow_double === 'on' || body.blackjack_allow_double === 'true';
      if (advancedAllowed) {
        const flag = (name: string) => body[name] === 'on' || body[name] === 'true';
        options.deckCount = clampInt(body.blackjack_deck_count, 1, 8, options.deckCount ?? 6);
        options.blackjackPayout = Math.max(1, Math.min(2, parseFloat(body.blackjack_payout) || options.blackjackPayout || 1.5));
        options.allowInsurance = flag('blackjack_allow_insurance');
        options.allowSurrender = flag('blackjack_allow_surrender');
        options.allowDoubleAny = flag('blackjack_allow_double_any');
        options.allowSplit = flag('blackjack_allow_split');
        options.maxHands = clampInt(body.blackjack_max_hands, 2, 6, options.maxHands ?? 4);
        options.allowResplitAces = flag('blackjack_allow_resplit_aces');
        options.allowDoubleAfterSplit = flag('blackjack_allow_double_after_split');
        options.dealerPeek = flag('blackjack_dealer_peek');
        options.noHoleCard = flag('blackjack_no_hole_card');
      }
    }
    if (!advancedAllowed) {
      delete options.deckCount;
      delete options.blackjackPayout;
      delete options.allowInsurance;
      delete options.allowSurrender;
      delete options.allowDoubleAny;
      delete options.allowSplit;
      delete options.maxHands;
      delete options.allowResplitAces;
      delete options.allowDoubleAfterSplit;
      delete options.dealerPeek;
      delete options.noHoleCard;
    }
  } else {
    problem = await pickModels(resolvedPlayerCount, i =>
      configuredRoles[i - 1] || (gameType === 'chess' ? (i === 1 ? 'white' : 'black') : `player${i}`)
    );
    options = { ...options, ...engineOptions };
    if (gameType !== 'chess') {
      options.playerCount = participants.length;
    }
  }
  if (problem) {
    return reject(req, res, problem.startsWith('Model not permitted') ? 403 : 400, problem);
  }

  // Drop undefined entries so engines fall back to their own defaults instead of receiving `undefined` overrides.
  Object.keys(options).forEach(key => options[key] === undefined && delete options[key]);

  // Reserve quota atomically right before creating the match; give it back if creation fails.
  let reservation: { allowed: boolean; release: () => Promise<unknown> } = { allowed: true, release: async () => undefined };
  if (entitlements?.resolved?.['matches.quota'] && entitlements.reserveQuota) {
    const scope = orgId ? { type: 'org' as const, id: orgId } : { type: 'user' as const, id: userId };
    reservation = await entitlements.reserveQuota('matches.quota', scope);
    if (!reservation.allowed) {
      return reject(req, res, 429, 'Match quota exceeded. Try again later.');
    }
  }

  try {
    await matchService.createMatch(participants, gameType, options, userId);
  } catch (error: any) {
    await reservation.release().catch(() => undefined);
    return reject(req, res, 503, error?.message || 'Could not create the match.');
  }

  res.redirect(`/matches${isRunnerEnabled() ? '' : '?queue=disabled'}`);
};

const BUILT_IN_RENDERERS: Record<string, string> = {
  chess: 'chess',
  chutes_and_ladders: 'chutes',
  texas_holdem: 'poker',
  blackjack: 'blackjack'
};
const KNOWN_RENDERERS = new Set(['generic', 'chess', 'chutes', 'poker', 'blackjack']);

/** Which replay presentation to use: built-ins have fixed boards; generated games choose via their replay schema. */
export const resolveRenderer = (gameType: string, replaySchema: any): string => {
  if (BUILT_IN_RENDERERS[gameType]) return BUILT_IN_RENDERERS[gameType];
  const requested = replaySchema && typeof replaySchema.renderer === 'string' ? replaySchema.renderer : 'generic';
  return KNOWN_RENDERERS.has(requested) ? requested : 'generic';
};

export const detail = async (req: Request, res: Response) => {
  if (!isDatabaseConfigured()) {
    return res.status(404).render('errors/404');
  }
  const match = await matchService.getMatch(req.params.id);
  if (!match) return res.status(404).send('Match not found');
  const gameDefinition = BUILT_IN_RENDERERS[match.game_type]
    ? null
    : await prisma.gameDefinition.findUnique({ where: { key: match.game_type }, select: { ui_schema: { select: { replay_schema: true } } } });
  const renderer = resolveRenderer(match.game_type, gameDefinition?.ui_schema?.replay_schema);
  const startEvent: any = (match.events || []).find((e: any) => e.type === 'MATCH_START');
  const boardSize = Math.max(25, Math.min(200, Number(startEvent?.payload?.board_size) || 100));
  const canonicalPath = `/matches/${match.id}`;
  const description = buildMatchDescription(match);
  const isIndexable = match.status === MatchStatus.COMPLETED;
  res.render('matches/detail', {
    title: `${match.game_type.replace(/[_-]/g, ' ')} Match Replay`,
    seo: buildSeo({
      title: `${match.game_type.replace(/[_-]/g, ' ')} Match Replay`,
      description,
      canonicalPath,
      robots: isIndexable ? 'index,follow' : 'noindex,follow',
      ogImageUrl: buildAbsoluteUrl(`/og/matches/${match.id}.png`),
      structuredData: [
        buildWebPageSchema(`${match.game_type.replace(/[_-]/g, ' ')} Match Replay`, description, canonicalPath),
        buildBreadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Matches', path: '/matches' },
          { name: match.id, path: canonicalPath }
        ])
      ]
    }),
    match,
    renderer,
    boardSize,
    path: '/matches'
  });
};

const TERMINAL_STATUSES: string[] = [MatchStatus.COMPLETED, MatchStatus.FAILED, MatchStatus.CANCELLED];

/**
 * Replay data. `?after=<seq>` returns only newer events, so a live viewer downloads one event per poll
 * instead of the whole log. Finished matches are cacheable by the CDN; running ones never are.
 */
export const events = async (req: Request, res: Response) => {
    if (!isDatabaseConfigured()) return res.json([]);
    const after = Number.parseInt(String(req.query.after ?? ''), 10);
    const incremental = Number.isFinite(after) && after >= 0;

    let status: MatchStatus | null;
    let rows: unknown[];
    if (incremental) {
        status = await matchRepo.getStatus(req.params.id);
        rows = status ? await matchRepo.findEventsAfter(req.params.id, after) : [];
    } else {
        const match = await matchService.getMatch(req.params.id);
        status = match ? match.status : null;
        rows = match ? match.events : [];
    }
    if (!status) return res.status(404).json({ error: 'Match not found' });

    res.setHeader('X-Match-Status', status);
    res.setHeader(
        'Cache-Control',
        TERMINAL_STATUSES.includes(status) ? 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400' : 'no-store'
    );
    res.json(rows);
};

export const ogImage = async (req: Request, res: Response) => {
  if (!isDatabaseConfigured()) return res.status(404).end();
  const match = await matchService.getMatch(req.params.id);
  if (!match) return res.status(404).end();

  const participantNames = (match.participants || [])
    .map(participant => participant.model?.name)
    .filter(Boolean)
    .slice(0, 3) as string[];

  const png = renderOgImage({
    theme: 'matches',
    eyebrow: match.game_type.replace(/[_-]/g, ' ').toUpperCase(),
    title: participantNames.length > 0 ? participantNames.join(' vs ') : `Match ${match.id.slice(0, 8)}`,
    description: buildMatchDescription(match),
    chips: [match.status, ...(participantNames.length > 2 ? [`+${participantNames.length - 2} more`] : [])].filter(Boolean),
    metricLabel: 'Replay status',
    metricValue: match.status,
    footerLeft: `Match ${match.id.slice(0, 8)}`,
    footerRight: 'Public replay'
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.send(png);
};
