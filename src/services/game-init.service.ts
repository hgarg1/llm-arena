import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';

const DEFAULT_GAMES = [
  {
    key: 'chess',
    name: 'Chess',
    description_short: 'Standard chess engine match.',
    roles: ['white', 'black'],
    capabilities: ['chess'],
    max_players: 2,
    settings: [
      { key: 'time_control_minutes', type: 'INT', default: 10, min: 1, max: 180, tier: 'FREE', help: 'Base time per side.' },
      { key: 'increment_seconds', type: 'INT', default: 0, min: 0, max: 60, tier: 'PRO', help: 'Increment per move.' },
      { key: 'allow_draws', type: 'BOOLEAN', default: true, tier: 'FREE', help: 'Allow draw by repetition or stalemate.' },
      { key: 'start_fen', type: 'TEXT', default: 'start', tier: 'ENTERPRISE', help: 'Custom starting FEN or "start".' }
    ],
    ui_schema: {
      create_form_layout: [
        { key: 'time_control_minutes', label: 'Time Control (min)', type: 'number', tier: 'FREE' },
        { key: 'increment_seconds', label: 'Increment (sec)', type: 'number', tier: 'PRO' },
        { key: 'allow_draws', label: 'Allow Draws', type: 'toggle', tier: 'FREE' },
        { key: 'start_fen', label: 'Start FEN', type: 'text', tier: 'ENTERPRISE' }
      ]
    }
  },
  {
    key: 'chutes_and_ladders',
    name: 'Chutes & Ladders',
    description_short: 'Classic race-to-100 board game.',
    roles: ['player'],
    capabilities: ['chutes_and_ladders'],
    max_players: 1,
    settings: [
      { key: 'board_size', type: 'INT', default: 100, min: 25, max: 200, tier: 'FREE', help: 'Number of squares.' },
      { key: 'win_exact', type: 'BOOLEAN', default: false, tier: 'PRO', help: 'Require exact landing on finish.' },
      { key: 'chutes_enabled', type: 'BOOLEAN', default: true, tier: 'FREE', help: 'Enable chutes.' },
      { key: 'ladders_enabled', type: 'BOOLEAN', default: true, tier: 'FREE', help: 'Enable ladders.' }
    ],
    ui_schema: {
      create_form_layout: [
        { key: 'board_size', label: 'Board Size', type: 'number', tier: 'FREE' },
        { key: 'win_exact', label: 'Exact Win', type: 'toggle', tier: 'PRO' },
        { key: 'chutes_enabled', label: 'Chutes Enabled', type: 'toggle', tier: 'FREE' },
        { key: 'ladders_enabled', label: 'Ladders Enabled', type: 'toggle', tier: 'FREE' }
      ]
    }
  },
  {
    key: 'texas_holdem',
    name: 'Texas Holdem Poker',
    description_short: 'No-limit Holdem poker engine.',
    roles: ['seat1', 'seat2', 'seat3', 'seat4', 'seat5', 'seat6'],
    capabilities: ['texas_holdem'],
    max_players: 6,
    settings: [
      { key: 'starting_stack', type: 'INT', default: 1000, min: 50, max: 20000, tier: 'FREE', help: 'Starting stack size.' },
      { key: 'small_blind', type: 'INT', default: 5, min: 1, max: 500, tier: 'FREE', help: 'Small blind amount.' },
      { key: 'big_blind', type: 'INT', default: 10, min: 2, max: 1000, tier: 'FREE', help: 'Big blind amount.' },
      { key: 'max_players', type: 'INT', default: 6, min: 2, max: 9, tier: 'PRO', help: 'Seats at the table.' },
      { key: 'allow_rebuy', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Enable rebuys during match.' }
    ],
    ui_schema: {
      create_form_layout: [
        { key: 'starting_stack', label: 'Starting Stack', type: 'number', tier: 'FREE' },
        { key: 'small_blind', label: 'Small Blind', type: 'number', tier: 'FREE' },
        { key: 'big_blind', label: 'Big Blind', type: 'number', tier: 'FREE' },
        { key: 'max_players', label: 'Max Players', type: 'number', tier: 'PRO' },
        { key: 'allow_rebuy', label: 'Allow Rebuy', type: 'toggle', tier: 'ENTERPRISE' }
      ]
    }
  },
  {
    key: 'blackjack',
    name: 'Blackjack',
    description_short: 'Dealer vs N-player blackjack.',
    roles: ['seat1', 'seat2', 'seat3', 'seat4', 'seat5', 'seat6'],
    capabilities: ['blackjack'],
    max_players: 6,
    settings: [
      { key: 'starting_stack', type: 'INT', default: 1000, min: 10, max: 100000, tier: 'FREE', help: 'Initial stack per seat.' },
      { key: 'fixed_bet', type: 'INT', default: 10, min: 1, max: 5000, tier: 'FREE', help: 'Fixed bet per hand.' },
      { key: 'dealer_hits_soft_17', type: 'BOOLEAN', default: false, tier: 'FREE', help: 'Dealer hits soft 17.' },
      { key: 'allow_double', type: 'BOOLEAN', default: true, tier: 'FREE', help: 'Allow double-down.' },
      { key: 'deck_count', type: 'INT', default: 6, min: 1, max: 8, tier: 'ENTERPRISE', help: 'Number of decks.' },
      { key: 'blackjack_payout', type: 'FLOAT', default: 1.5, min: 1, max: 2, tier: 'ENTERPRISE', help: 'Blackjack payout ratio.' },
      { key: 'allow_insurance', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow insurance.' },
      { key: 'allow_surrender', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow late surrender.' },
      { key: 'allow_double_any', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow double on any count.' },
      { key: 'allow_split', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow split hands.' },
      { key: 'max_hands', type: 'INT', default: 4, min: 2, max: 6, tier: 'ENTERPRISE', help: 'Max hands after split.' },
      { key: 'allow_resplit_aces', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow resplitting aces.' },
      { key: 'allow_double_after_split', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Allow double after split.' },
      { key: 'dealer_peek', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'Dealer peeks for blackjack.' },
      { key: 'no_hole_card', type: 'BOOLEAN', default: false, tier: 'ENTERPRISE', help: 'European no-hole-card rule.' }
    ],
    ui_schema: {
      create_form_layout: [
        { key: 'starting_stack', label: 'Starting Stack', type: 'number', tier: 'FREE' },
        { key: 'fixed_bet', label: 'Fixed Bet', type: 'number', tier: 'FREE' },
        { key: 'dealer_hits_soft_17', label: 'Dealer Hits Soft 17', type: 'toggle', tier: 'FREE' },
        { key: 'allow_double', label: 'Allow Double', type: 'toggle', tier: 'FREE' },
        { key: 'deck_count', label: 'Deck Count', type: 'number', tier: 'ENTERPRISE' },
        { key: 'blackjack_payout', label: 'Blackjack Payout', type: 'number', tier: 'ENTERPRISE' },
        { key: 'allow_insurance', label: 'Allow Insurance', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'allow_surrender', label: 'Allow Surrender', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'allow_double_any', label: 'Allow Double Any', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'allow_split', label: 'Allow Split', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'max_hands', label: 'Max Hands', type: 'number', tier: 'ENTERPRISE' },
        { key: 'allow_resplit_aces', label: 'Allow Resplit Aces', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'allow_double_after_split', label: 'Allow Double After Split', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'dealer_peek', label: 'Dealer Peek', type: 'toggle', tier: 'ENTERPRISE' },
        { key: 'no_hole_card', label: 'No Hole Card', type: 'toggle', tier: 'ENTERPRISE' }
      ]
    }
  }
];

export const ensureDefaultGames = async () => {
  for (const game of DEFAULT_GAMES) {
    const existing = await prisma.gameDefinition.findUnique({
      where: { key: game.key },
      include: { settings: true, ui_schema: true, releases: true }
    });

    if (!existing) {
      await prisma.gameDefinition.create({
        data: {
          key: game.key,
          name: game.name,
          description_short: game.description_short,
          roles: game.roles,
          capabilities: game.capabilities,
          max_players: game.max_players,
          status: 'LIVE',
          settings: {
            create: game.settings.map(setting => ({
              key: setting.key,
              type: setting.type as any,
              min_value: setting.min ?? Prisma.DbNull,
              max_value: setting.max ?? Prisma.DbNull,
              default_value: setting.default as any,
              tier_required: setting.tier as any,
              help_text: setting.help || null,
              enum_options: []
            }))
          },
          ui_schema: {
            create: {
              create_form_layout: game.ui_schema.create_form_layout
            }
          },
          releases: {
            create: { status: 'LIVE' }
          }
        }
      });
      continue;
    }

    if (existing.settings.length === 0) {
      await prisma.gameSetting.createMany({
        data: game.settings.map(setting => ({
          game_id: existing.id,
          key: setting.key,
          type: setting.type as any,
          min_value: setting.min ?? Prisma.DbNull,
          max_value: setting.max ?? Prisma.DbNull,
          default_value: setting.default as any,
          tier_required: setting.tier as any,
          help_text: setting.help || null,
          enum_options: []
        }))
      });
    }

    if (!existing.ui_schema) {
      await prisma.gameUISchema.create({
        data: {
          game_id: existing.id,
          create_form_layout: game.ui_schema.create_form_layout
        }
      });
    }

    if (!existing.releases || existing.releases.length === 0) {
      await prisma.gameRelease.create({
        data: { game_id: existing.id, status: 'LIVE' }
      });
    }

    if (existing.status === 'DRAFT') {
      await prisma.gameDefinition.update({
        where: { id: existing.id },
        data: { status: 'LIVE' }
      });
    }
  }
};
