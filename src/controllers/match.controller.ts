import { Request, Response } from 'express';
import { MatchService } from '../services/match.service';
import { ModelRepository } from '../repositories/model.repository';
import { MatchRepository } from '../repositories/match.repository';
import { MatchStatus } from '@prisma/client';
import { prisma } from '../config/db';

const matchService = new MatchService();
const modelRepo = new ModelRepository();
const matchRepo = new MatchRepository();

const getGameDefaults = async (gameKey: string) => {
  const game = await prisma.gameDefinition.findUnique({
    where: { key: gameKey },
    include: { settings: true }
  });
  if (!game) return { settings: {}, tiers: {}, list: [] };
  const settings: Record<string, any> = {};
  const tiers: Record<string, string> = {};
  game.settings.forEach(setting => {
    settings[setting.key] = setting.default_value === null ? undefined : setting.default_value;
    tiers[setting.key] = setting.tier_required;
  });
  return { settings, tiers, list: game.settings };
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

const mapOptionsToEngine = (gameType: string, options: Record<string, any>) => {
  if (gameType === 'chess') {
    return {
      startFen: options.start_fen,
      maxPlies: options.max_plies,
      allowDraws: options.allow_draws,
      timeControlMinutes: options.time_control_minutes,
      incrementSeconds: options.increment_seconds
    };
  }
  if (gameType === 'chutes_and_ladders') {
    return {
      boardSize: options.board_size,
      winExact: options.win_exact,
      chutesEnabled: options.chutes_enabled,
      laddersEnabled: options.ladders_enabled
    };
  }
  if (gameType === 'texas_holdem') {
    return {
      startingStack: options.starting_stack,
      smallBlind: options.small_blind,
      bigBlind: options.big_blind
    };
  }
  if (gameType === 'blackjack') {
    return {
      startingStack: options.starting_stack,
      fixedBet: options.fixed_bet,
      dealerHitsSoft17: options.dealer_hits_soft_17,
      allowDouble: options.allow_double,
      deckCount: options.deck_count,
      blackjackPayout: options.blackjack_payout,
      allowInsurance: options.allow_insurance,
      allowSurrender: options.allow_surrender,
      allowDoubleAny: options.allow_double_any,
      allowSplit: options.allow_split,
      maxHands: options.max_hands,
      allowResplitAces: options.allow_resplit_aces,
      allowDoubleAfterSplit: options.allow_double_after_split,
      dealerPeek: options.dealer_peek,
      noHoleCard: options.no_hole_card
    };
  }
  return options;
};

export const list = async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const search = req.query.q as string;
  const gameType = req.query.game as string;
  const status = req.query.status as MatchStatus;

  const result = await matchRepo.findAll({ page, search, gameType, status });
  
  res.render('matches/list', { 
      title: 'Matches', 
      matches: result.matches, 
      pagination: {
          page: result.page,
          totalPages: result.totalPages,
          total: result.total
      },
      query: { search, gameType, status },
      path: '/matches'
  });
};

export const createPage = async (req: Request, res: Response) => {
  const models = await modelRepo.findAll();
  const gameDefinitions = await prisma.gameDefinition.findMany({
    include: { settings: true, ui_schema: true }
  });
  const gameDefaults = gameDefinitions.reduce<Record<string, any>>((acc, game) => {
    acc[game.key] = {
      settings: game.settings.reduce<Record<string, any>>((map, setting) => {
        map[setting.key] = setting.default_value === null ? undefined : setting.default_value;
        return map;
      }, {})
    };
    return acc;
  }, {});
  const gameCatalog = gameDefinitions.reduce<Record<string, any>>((acc, game) => {
    acc[game.key] = {
      name: game.name,
      settings: game.settings,
      ui_schema: game.ui_schema
    };
    return acc;
  }, {});
  res.render('matches/create', { title: 'Create Match', models, path: '/matches', gameDefaults, gameCatalog });
};

export const create = async (req: Request, res: Response) => {
  const { gameType, playerCount, dealerSeat } = req.body;
  const participants = [];
  let options: any = {};
  const userTier = (req.session as any).user?.tier;
  const advancedAllowed = userTier === 'ENTERPRISE';
  const defaults = await getGameDefaults(gameType || 'iterated-negotiation');
  const gameOptions = parseGameOptions(req.body.game_options, defaults.list, userTier || 'FREE');
  const mergedOptions = { ...defaults.settings, ...gameOptions };
  const engineOptions = mapOptionsToEngine(gameType || 'iterated-negotiation', mergedOptions);

  if (gameType === 'chutes_and_ladders') {
      const modelId = req.body.model1Id;
      if (!modelId) return res.status(400).send('Select a model');
      participants.push({ modelId, role: 'player1' });
      options = { ...options, ...engineOptions };
  } else if (gameType === 'texas_holdem') {
      const count = parseInt(playerCount) || parseInt(defaults.settings.max_players || '2', 10);
      for (let i = 1; i <= count; i++) {
          const modelId = req.body[`model${i}Id`];
          if (!modelId) return res.status(400).send(`Select a model for Seat ${i}`);
          participants.push({ modelId, role: `seat${i}` });
      }
      
      options.playerCount = count;
      options = { ...options, ...engineOptions };
      if (dealerSeat && dealerSeat !== 'random') {
          // dealerSeat is 1-based (Seat 1), dealerIndex is 0-based
          options.dealerIndex = parseInt(dealerSeat) - 1;
      }
  } else if (gameType === 'blackjack') {
      const count = parseInt(playerCount) || 1;
      for (let i = 1; i <= count; i++) {
          const modelId = req.body[`model${i}Id`];
          if (!modelId) return res.status(400).send(`Select a model for Seat ${i}`);
          participants.push({ modelId, role: `seat${i}` });
      }

      const defaultFixedBet = parseInt(defaults.settings.fixed_bet || '10', 10);
      const defaultStartingStack = parseInt(defaults.settings.starting_stack || '1000', 10);
      const defaultDealerHitsSoft17 = defaults.settings.dealer_hits_soft_17 === true;
      const defaultAllowDouble = defaults.settings.allow_double !== false;

      const fixedBet = Math.max(1, parseInt(req.body.blackjack_fixed_bet || String(defaultFixedBet), 10));
      const startingStack = Math.max(1, parseInt(req.body.blackjack_starting_stack || String(defaultStartingStack), 10));
      const dealerHitsSoft17 = req.body.blackjack_dealer_hits_soft_17 === 'on' ? true : defaultDealerHitsSoft17;
      const allowDouble = req.body.blackjack_allow_double === 'off' ? false : defaultAllowDouble;

      options.playerCount = count;
      options.fixedBet = Math.min(fixedBet, startingStack);
      options.startingStack = startingStack;
      options.dealerHitsSoft17 = dealerHitsSoft17;
      options.allowDouble = allowDouble;

      options = { ...options, ...engineOptions };
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
      // Standard 2-player games (Chess, Negotiation)
      const m1 = req.body.model1Id;
      const m2 = req.body.model2Id;
      if (!m1 || !m2) return res.status(400).send('Select two models');
      
      participants.push({ modelId: m1, role: gameType === 'chess' ? 'white' : 'player1' });
      participants.push({ modelId: m2, role: gameType === 'chess' ? 'black' : 'player2' });
      if (gameType === 'chess') {
        options = { ...options, ...engineOptions };
      }
  }

  await matchService.createMatch(participants, gameType || 'iterated-negotiation', options, (req.session as any).userId);
  
  res.redirect('/matches');
};

export const detail = async (req: Request, res: Response) => {
  const match = await matchService.getMatch(req.params.id);
  if (!match) return res.status(404).send('Match not found');
  res.render('matches/detail', { title: 'Match Replay', match, path: '/matches' });
};

export const events = async (req: Request, res: Response) => {
    const match = await matchService.getMatch(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match.events);
}
