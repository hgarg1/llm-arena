/**
 * Fixtures for the signed-in app pages (match wizard, replay viewer, models, account), modelled on what the controllers pass
 * to the views. They are handed to startTablesSite(extra) so the REAL EJS views render with the real tailwind build.
 */
import type { TablePage } from './tables-harness';

const LONG_MODEL = 'anthropic/claude-3-5-sonnet-20241022-extended-reasoning-preview';
const LONG_EMAIL = 'archie.garg-with-a-very-long-address-for-testing@harshit-garg-and-company.example.com';
const ago = (days: number) => new Date(Date.UTC(2026, 10, 8) - days * 86_400_000);

/** Models as /api/models returns them. */
export const apiModels = [
  { id: 'm1', name: LONG_MODEL, api_provider: 'openrouter', api_model_id: LONG_MODEL },
  { id: 'm2', name: 'GPT-4o', api_provider: 'openai', api_model_id: 'gpt-4o' },
  { id: 'm3', name: 'Llama 3.1 405B Instruct Turbo', api_provider: 'together', api_model_id: 'meta-llama/Llama-3.1-405B-Instruct-Turbo' },
  { id: 'm4', name: 'Mock Model', api_provider: 'mock', api_model_id: 'mock' },
  { id: 'm5', name: 'Mistral Large', api_provider: 'mistral', api_model_id: 'mistral-large' },
  { id: 'm6', name: 'Gemini 1.5 Pro Experimental 0827 With Grounding', api_provider: 'google', api_model_id: 'gemini-1.5-pro-exp-0827' }
];

const setting = (key: string, type: string, extra: Record<string, any> = {}) => ({ key, type, default_value: null, tier_required: 'FREE', enum_options: [], help_text: '', min_value: null, max_value: null, ...extra });

export const gameCatalog: Record<string, any> = {
  chess: { name: 'Chess', capabilities: ['chess'], roles: ['white', 'black'], max_players: 2, settings: [], ui_schema: null },
  texas_holdem: {
    name: "Texas Hold'em", capabilities: ['poker'], roles: [], max_players: 6, ui_schema: null,
    settings: [setting('starting_stack', 'INT', { default_value: 1000 }), setting('small_blind', 'INT', { default_value: 5 }), setting('big_blind', 'INT', { default_value: 10 })]
  },
  blackjack: {
    name: 'Blackjack', capabilities: ['blackjack'], roles: [], max_players: 6, ui_schema: null,
    settings: [setting('starting_stack', 'INT', { default_value: 1000 }), setting('fixed_bet', 'INT', { default_value: 10 })]
  },
  chutes_and_ladders: { name: 'Chutes and Ladders', capabilities: ['chutes'], roles: ['player'], max_players: 1, settings: [], ui_schema: null },
  'iterated-prisoners-dilemma-with-reputation-and-communication-channel': {
    name: 'Iterated Prisoner\'s Dilemma With Reputation And A Communication Channel',
    capabilities: ['negotiation'], roles: ['cooperative-proposer', 'skeptical-responder'], max_players: 2,
    settings: [
      setting('max_rounds', 'INT', { default_value: 12, min_value: 1, max_value: 50 }),
      setting('payoff_matrix_preset', 'ENUM', { default_value: 'standard-payoff-matrix', enum_options: ['standard-payoff-matrix', 'asymmetric-payoff-matrix-with-penalties'] }),
      setting('allow_messages', 'BOOLEAN', { default_value: true, help_text: 'Let the agents exchange free-form messages between rounds' }),
      setting('scenario_notes', 'TEXT', { default_value: '' }),
      setting('hidden_turn_budget', 'INT', { default_value: 3, tier_required: 'ENTERPRISE' })
    ],
    ui_schema: {
      create_form_layout: [
        { key: 'max_rounds', label: 'Maximum Rounds Before Forced Termination' },
        { key: 'payoff_matrix_preset', label: 'Payoff Matrix Preset' },
        { key: 'allow_messages', label: 'Allow Messaging Between Agents', type: 'toggle' },
        { key: 'scenario_notes', label: 'Scenario Notes' },
        { key: 'hidden_turn_budget', label: 'Hidden Turn Budget', tier: 'ENTERPRISE' }
      ]
    }
  }
};
export const gameDefaults = Object.fromEntries(Object.entries(gameCatalog).map(([key, game]) => [
  key,
  { settings: Object.fromEntries(game.settings.filter((s: any) => s.default_value !== null).map((s: any) => [s.key, s.default_value])) }
]));

const player = (tier: string) => ({ id: 'u0', email: 'archie@example.com', name: 'Archie Garg', tier, role: 'USER', avatar_url: null });

// ------------------------------------------------------------------ replay events

let seq = 0;
const ev = (type: string, actor_role: string, payload: any, turn_index = 0) => ({
  id: `e${++seq}`, seq, type, actor_role, turn_index, payload, created_at: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString()
});
const LONG_TEXT = 'I propose we split the surplus evenly, but only if you accept the additional clause ' + 'unbreakable-token-'.repeat(8) + ' so that neither side can defect in the final round.';
const FENS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'
];

export const replayEvents = (kind: string): any[] => {
  seq = 0;
  if (kind === 'chess') {
    return [
      ev('MATCH_START', 'system', { game_key: 'chess', start_fen: FENS[0] }),
      ...['e4', 'e5', 'Nf3', 'Nc6'].map((san, i) => ev('MOVE', i % 2 ? 'black' : 'white', { san, uci: san, fen_after: FENS[i + 1], content: LONG_MODEL + ' plays ' + san }, i + 1)),
      ev('RESULT', 'system', { outcome: 'draw', reason: 'agreement' }, 5)
    ];
  }
  if (kind === 'chutes') {
    const evs: any[] = [ev('MATCH_START', 'system', { game_key: 'chutes_and_ladders', board_size: 100 })];
    [4, 14, 20, 38, 51, 67].forEach((position_after, i) => evs.push(ev('MOVE', 'player', { roll: 4, position_after, message: `Rolled a ${i + 1} and moved to ${position_after}` }, i + 1)));
    evs.push(ev('RESULT', 'system', { outcome: 'win', final_position: 100 }, 7));
    return evs;
  }
  if (kind === 'poker' || kind === 'poker6') {
    const count = kind === 'poker6' ? 6 : 2;
    const evs: any[] = [ev('MATCH_START', 'system', { game_key: 'texas_holdem', player_count: count, starting_stack: 10000 })];
    const cards = ['Ah', 'Kd', 'Qs', 'Jc', 'Th', '9d', '2c', '3s', '4h', '5d', '6c', '7s'];
    for (let i = 0; i < count; i++) evs.push(ev('DEAL_HOLE_CARDS', 'system', { seat: i + 1, cards: [cards[i * 2 % 12], cards[(i * 2 + 1) % 12]] }));
    evs.push(ev('POST_BLINDS', 'system', { sb_seat: 1, bb_seat: 2, amounts: [50, 100] }));
    evs.push(ev('PLAYER_ACTION', 'player1', { seat: 1, action: 'raise', stack_after: 9700, content: 'raise to 300' }, 1));
    evs.push(ev('DEAL_COMMUNITY', 'system', { round: 'flop', cards: ['Ah', 'Kd', 'Qs'] }, 2));
    evs.push(ev('DEAL_COMMUNITY', 'system', { round: 'turn', cards: ['Jc'] }, 3));
    evs.push(ev('DEAL_COMMUNITY', 'system', { round: 'river', cards: ['Th'] }, 4));
    evs.push(ev('SHOWDOWN', 'system', {}, 5));
    return evs;
  }
  if (kind === 'blackjack') {
    const evs: any[] = [ev('MATCH_START', 'system', { game_key: 'blackjack', player_count: 4, starting_stack: 10000, fixed_bet: 100 })];
    const hands = [['Ah', 'Kd'], ['9s', '8c'], ['Qh', '5d'], ['Th', 'Td']];
    hands.forEach((hand, i) => hand.forEach(card => evs.push(ev('DEAL_CARD', 'system', { seat: i + 1, card }))));
    evs.push(ev('DEAL_DEALER', 'system', { cards: ['6h'] }));
    evs.push(ev('PLAYER_ACTION', 'player1', { seat: 1, action: 'stand' }, 1));
    evs.push(ev('PLAYER_TURN_END', 'system', { seat: 1, result: 'stand' }, 1));
    evs.push(ev('PLAYER_ACTION', 'player3', { seat: 3, action: 'hit' }, 2));
    evs.push(ev('DEAL_CARD', 'system', { seat: 3, card: '9c' }, 2));
    evs.push(ev('PLAYER_TURN_END', 'system', { seat: 3, result: 'bust' }, 2));
    evs.push(ev('DEALER_REVEAL', 'system', { cards: ['6h', 'Kc'] }, 3));
    return evs;
  }
  // generic generated game: chatty transcript with long unbroken strings
  const evs: any[] = [ev('MATCH_START', 'system', { game_key: 'iterated-prisoners-dilemma' })];
  for (let i = 0; i < 6; i++) evs.push(ev('MESSAGE', i % 2 ? 'cooperative-proposer' : 'skeptical-responder', { content: LONG_TEXT }, i + 1));
  evs.push(ev('RESULT', 'system', { outcome: 'draw', reason: 'max rounds reached' }, 7));
  return evs;
};

const participantsFor = (roles: string[]) => roles.map((role, i) => ({
  role, score: i === 0 ? 3 : null, model: { name: i % 2 ? 'GPT-4o' : LONG_MODEL }
}));
const matchOf = (kind: string, game_type: string, roles: string[], status = 'COMPLETED', extra: Record<string, any> = {}) => ({
  id: `${kind}-0a1b2c3d-4e5f-6789-abcd-ef0123456789`, game_type, status, failure_reason: null, created_at: ago(1), finished_at: ago(1),
  participants: participantsFor(roles), events: [], ...extra
});

const replayPage = (kind: string, renderer: string, game_type: string, roles: string[], status = 'COMPLETED', extra: Record<string, any> = {}): TablePage => ({
  view: 'matches/detail.ejs', text: ['Match Replay'],
  locals: { path: '/matches', match: matchOf(kind, game_type, roles, status, extra), renderer, boardSize: 100 }
});

// ------------------------------------------------------------------ models / account

const modelRow = (i: number) => ({
  id: `model-${i}-0a1b2c3d-4e5f-6789`,
  name: i === 0 ? LONG_MODEL : ['GPT-4o', 'Llama 3.1 405B Instruct Turbo', 'Gemini 1.5 Pro Experimental 0827 With Grounding', 'Mistral Large'][i % 4],
  api_provider: ['openrouter', 'openai', 'anthropic', 'google', 'xai', 'zhipu'][i % 6],
  api_model_id: i === 0 ? LONG_MODEL : `provider-org/some-model-identifier-${i}-with-a-long-suffix-for-checking-truncation`,
  description: i % 2 ? 'A general-purpose model that is used across many of the evaluation games, including long-horizon negotiation and poker.' : null,
  is_active: true, owner_id: i % 3 ? 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' : null, created_at: ago(40 + i)
});

const planRow = (i: number) => ({
  id: `p${i}`, name: ['Free', 'Pro Team Plan With A Long Name', 'Enterprise'][i], level: i + 1, price_cents: i === 2 ? null : i * 4900, interval: 'month',
  description_short: ['For trying things out', 'For small teams that run evaluations every day', 'Custom limits, SSO and priority support'][i],
  description_long: 'Includes 100 matches per month, 3 models per team, the standard game library and community support through the chat channels. ' + 'verylongunbrokenwordinsideplandescription'.repeat(2)
});

const accountUser = (over: Record<string, any> = {}) => ({
  id: 'u0', email: LONG_EMAIL, name: 'Archie Garg-Subramanian the Third of Harshit Garg and Company', job_title: 'Principal evaluation engineer', company: 'Harshit Garg & Company Evaluations Incorporated',
  tier: 'PRO', role: 'USER', avatar_url: null, email_verified: true, mfa_enabled: false, chat_notifications_enabled: true, chat_notifications_sound: false,
  chat_notifications_rate_limit: 5, chat_presence_visible: true, plan: null,
  matches: ['COMPLETED', 'RUNNING', 'FAILED'].map((status, i) => ({ id: `0a1b2c3d-4e5f-6789-abcd-ef01234567${i}${i}`, game_type: i ? 'texas_holdem' : 'iterated-prisoners-dilemma-with-reputation', status, created_at: ago(i) })),
  api_keys: [0, 1].map(i => ({
    id: `k${i}`, name: i ? 'CI/CD pipeline key for the leaderboard export job' : 'Production', prefix: 'abcd1234', key_hash: 'x'.repeat(64), status: i ? 'SUSPENDED' : 'ACTIVE',
    created_at: ago(10), last_used: i ? null : ago(1), scopes: [{ scope_key: 'matches.read' }, { scope_key: 'models.read' }, { scope_key: 'leaderboard.export.something.long' }]
  })),
  passkeys: [{ credential_id: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', created_at: ago(3) }, { credential_id: 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210', created_at: ago(30) }],
  ...over
});

const accountLocals = (over: Record<string, any> = {}, user: Record<string, any> = {}) => ({
  path: '/account', user: accountUser(user), plans: [0, 1, 2].map(planRow), currentPlanId: 'p1', currentPlanName: 'Pro Team Plan With A Long Name', currentPlanLevel: 2,
  success: undefined, error: undefined, newApiKey: null,
  availableApiScopes: ['matches.read', 'matches.write', 'models.read', 'leaderboard.export', 'chat.messages.send'].map(key => ({ key, label: key.replace(/\./g, ' ') })),
  allowedApiScopeKeys: ['matches.read'], settings: {},
  ...over
});

export const appPages: Record<string, TablePage> = {
  'match-create': {
    view: 'matches/create.ejs', text: ['Create New Match', 'Start Evaluation'],
    locals: { path: '/matches/create', user: player('PRO'), models: apiModels, gameDefaults, gameCatalog, error: undefined, queueEnabled: false }
  },
  'match-create-enterprise': {
    view: 'matches/create.ejs', text: ['Create New Match'],
    locals: { path: '/matches/create', user: player('ENTERPRISE'), models: apiModels, gameDefaults, gameCatalog, error: 'Model not permitted for your plan: ' + LONG_MODEL, queueEnabled: true }
  },
  'match-chess': replayPage('chess', 'chess', 'chess', ['white', 'black']),
  'match-chutes': replayPage('chutes', 'chutes', 'chutes_and_ladders', ['player']),
  'match-poker': replayPage('poker', 'poker', 'texas_holdem', ['player1', 'player2']),
  'match-poker6': replayPage('poker6', 'poker', 'texas_holdem', ['player1', 'player2', 'player3', 'player4', 'player5', 'player6']),
  'match-blackjack': replayPage('blackjack', 'blackjack', 'blackjack', ['player1', 'player2', 'player3', 'player4']),
  'match-generic': replayPage('generic', 'generic', 'iterated-prisoners-dilemma-with-reputation-and-communication-channel', ['cooperative-proposer', 'skeptical-responder']),
  'match-failed': replayPage('failed', 'chess', 'chess', ['white', 'black'], 'FAILED', { failure_reason: 'Provider timeout after 30000ms while waiting for ' + LONG_MODEL }),
  'match-live': replayPage('live', 'generic', 'iterated-prisoners-dilemma-with-reputation-and-communication-channel', ['cooperative-proposer', 'skeptical-responder'], 'RUNNING'),
  'models-list': {
    view: 'models/list.ejs', text: ['Registered Models', 'Showing 8 models'],
    locals: { path: '/models', models: Array.from({ length: 8 }, (_, i) => modelRow(i)), query: { search: 'claude', provider: 'openai' }, allProviders: ['openai', 'anthropic', 'google', 'xai', 'zhipu', 'mock'] }
  },
  'models-empty': {
    view: 'models/list.ejs', text: ['No models found'],
    locals: { path: '/models', models: [], query: { search: 'zzz', provider: '' }, allProviders: ['openai', 'anthropic'] }
  },
  'model-detail': { view: 'models/detail.ejs', text: [LONG_MODEL.slice(0, 20)], locals: { path: '/models', model: modelRow(0) } },
  'account-settings': { view: 'account/settings.ejs', text: ['Account Settings', 'Personal Information'], locals: accountLocals({ success: 'Profile updated successfully' }) },
  'account-settings-new-key': {
    view: 'account/settings.ejs', text: ['New API Key Generated'],
    locals: accountLocals({ success: 'API Key created', newApiKey: 'sk-' + 'AbCdEf0123456789'.repeat(5) }, { email_verified: false, mfa_enabled: true, avatar_url: '/img/icon.svg', api_keys: [], passkeys: [], matches: [] })
  },
  'mfa-setup-1': {
    view: 'account/mfa-setup.ejs', text: ['Two-Factor Authentication', 'Verify & Activate'],
    locals: { path: '/account', step: 1, error: 'Invalid Code: please try the new six digit code from your authenticator app again', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', qrCode: '/img/icon.svg' }
  },
  'mfa-setup-2': {
    view: 'account/mfa-setup.ejs', text: ['2FA Enabled Successfully'],
    locals: { path: '/account', step: 2, error: null, backupCodes: Array.from({ length: 10 }, (_, i) => `ABCD${i}-EFGH${i}-IJKL`) }
  }
};
