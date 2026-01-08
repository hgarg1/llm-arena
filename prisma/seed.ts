import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { RBAC_PERMISSIONS } from '../src/services/rbac.service';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('admin123', 10);

  // RBAC permissions
  const permissionMap: Record<string, string> = {};
  for (const perm of RBAC_PERMISSIONS) {
    const permission = await prisma.rbacPermission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description }
    });
    permissionMap[perm.key] = permission.id;
  }

  const upsertRole = async (name: string, description: string, allow: string[]) => {
    const role = await prisma.rbacRole.upsert({
      where: { name },
      update: { description },
      create: { name, description }
    });

    await prisma.rbacRolePermission.deleteMany({ where: { role_id: role.id } });
    for (const key of allow) {
      const permId = permissionMap[key];
      if (!permId) continue;
      await prisma.rbacRolePermission.create({
        data: { role_id: role.id, permission_id: permId, effect: 'ALLOW' }
      });
    }
    return role;
  };

  const allPerms = RBAC_PERMISSIONS.map(p => p.key);
  const superAdminRole = await upsertRole('SuperAdmin', 'Full access', allPerms);
  const contentAdminRole = await upsertRole('ContentAdmin', 'Content and media management', [
    'admin.access',
    'admin.dashboard.view',
    'admin.content.view',
    'admin.content.edit',
    'admin.media.view',
    'admin.media.upload',
    'admin.media.delete'
  ]);
  const supportAdminRole = await upsertRole('SupportAdmin', 'User support and account actions', [
    'admin.access',
    'admin.dashboard.view',
    'admin.users.view',
    'admin.users.edit',
    'admin.users.password_reset',
    'admin.users.2fa_reset',
    'admin.users.ban',
    'admin.users.unban',
    'admin.chat.manage'
  ]);
  const opsAdminRole = await upsertRole('OpsAdmin', 'Operations and queue management', [
    'admin.access',
    'admin.dashboard.view',
    'admin.matches.view',
    'admin.matches.cancel',
    'admin.matches.retry',
    'admin.queue.view',
    'admin.queue.retry',
    'admin.queue.clean',
    'admin.analytics.view',
    'admin.chat.manage',
    'admin.chat.broadcast',
    'admin.settings.chat_config',
    'admin.users.chat_settings',
    'admin.ai_chat.access',
    'admin.ai_chat.query'
  ]);

  // Create Admin User
  const admin = await prisma.user.upsert({
    where: { email: 'admin@llmarena.com' },
    update: {
      email_verified: true,
      email_verification_token: null
    },
    create: {
      email: 'admin@llmarena.com',
      password_hash: passwordHash,
      role: 'ADMIN',
      tier: 'ENTERPRISE',
      email_verified: true,
    },
  });

  await prisma.rbacUserRole.upsert({
    where: { user_id_role_id: { user_id: admin.id, role_id: superAdminRole.id } },
    update: {},
    create: { user_id: admin.id, role_id: superAdminRole.id }
  });

  const supportGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Support' },
    update: {},
    create: { name: 'Support', description: 'Support group' }
  });
  const contentGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Content' },
    update: {},
    create: { name: 'Content', description: 'Content group' }
  });
  const opsGroup = await prisma.rbacGroup.upsert({
    where: { name: 'Ops' },
    update: {},
    create: { name: 'Ops', description: 'Operations group' }
  });

  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: supportGroup.id, role_id: supportAdminRole.id } },
    update: {},
    create: { group_id: supportGroup.id, role_id: supportAdminRole.id }
  });
  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: contentGroup.id, role_id: contentAdminRole.id } },
    update: {},
    create: { group_id: contentGroup.id, role_id: contentAdminRole.id }
  });
  await prisma.rbacGroupRole.upsert({
    where: { group_id_role_id: { group_id: opsGroup.id, role_id: opsAdminRole.id } },
    update: {},
    create: { group_id: opsGroup.id, role_id: opsAdminRole.id }
  });

  console.log({ admin });

  // Create Mock Models
  const modelA = await prisma.model.create({
    data: {
      name: 'Negotiator Bot Alpha',
      description: 'A simple deterministic bot that favors splitting.',
      api_provider: 'mock',
      api_model_id: 'mock-v1',
      owner_id: admin.id,
      capabilities: ['iterated-negotiation', 'chutes_and_ladders']
    }
  });

  const modelB = await prisma.model.create({
    data: {
      name: 'Aggressive Trader Beta',
      description: 'A bot that pushes for 60/40 splits.',
      api_provider: 'mock',
      api_model_id: 'mock-v1',
      owner_id: admin.id,
      capabilities: ['iterated-negotiation']
    }
  });

  const modelC = await prisma.model.create({
    data: {
      name: 'OpenAI GPT-4 (Stub)',
      description: 'Stub for GPT-4 integration.',
      api_provider: 'openai',
      api_model_id: 'gpt-4',
      owner_id: admin.id,
      capabilities: ['iterated-negotiation', 'chess', 'chutes_and_ladders', 'texas_holdem', 'blackjack']
    }
  });

  // Create Mock Chess Models
  const chessBotA = await prisma.model.create({
    data: {
      name: 'Grandmaster Mock A',
      description: 'A mock chess engine.',
      api_provider: 'mock',
      api_model_id: 'mock-chess-v1',
      owner_id: admin.id,
      capabilities: ['chess']
    }
  });

  const chessBotB = await prisma.model.create({
    data: {
      name: 'Grandmaster Mock B',
      description: 'Another mock chess engine.',
      api_provider: 'mock',
      api_model_id: 'mock-chess-v1',
      owner_id: admin.id,
      capabilities: ['chess', 'texas_holdem']
    }
  });

  // Seed Chess Match
  const chessMatch = await prisma.match.create({
      data: {
          game_type: 'chess',
          seed: 12345,
          status: 'COMPLETED',
          participants: {
              create: [
                  { model_id: chessBotA.id, role: 'white' },
                  { model_id: chessBotB.id, role: 'black' }
              ]
          }
      }
  });
  
  // Create sample events for chess match
  await prisma.matchEvent.createMany({
      data: [
          { match_id: chessMatch.id, turn_index: 0, type: 'MATCH_START', payload: { start_fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' } },
          { match_id: chessMatch.id, turn_index: 1, actor_role: 'white', type: 'MOVE', payload: { side: 'white', san: 'e4', uci: 'e2e4', fen_after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' } },
          { match_id: chessMatch.id, turn_index: 2, actor_role: 'black', type: 'MOVE', payload: { side: 'black', san: 'e5', uci: 'e7e5', fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2' } },
          { match_id: chessMatch.id, turn_index: 3, actor_role: 'white', type: 'MOVE', payload: { side: 'white', san: 'Nf3', uci: 'g1f3', fen_after: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' } }
      ]
  });

  // Seed Chutes Match
  const chutesMatch = await prisma.match.create({
      data: {
          game_type: 'chutes_and_ladders',
          seed: 999,
          status: 'COMPLETED',
          participants: {
              create: [
                  { model_id: modelA.id, role: 'player1' }
              ]
          }
      }
  });

  await prisma.matchEvent.createMany({
      data: [
          { match_id: chutesMatch.id, turn_index: 0, type: 'MATCH_START', payload: { game_key: 'chutes_and_ladders', seed: 999 } },
          { match_id: chutesMatch.id, turn_index: 1, actor_role: 'system', type: 'TURN_START', payload: { turn_index: 1, position_before: 0 } },
          { match_id: chutesMatch.id, turn_index: 1, actor_role: 'system', type: 'DICE_ROLL', payload: { turn_index: 1, roll: 4 } },
          { match_id: chutesMatch.id, turn_index: 1, actor_role: 'system', type: 'MOVE', payload: { turn_index: 1, from: 0, to: 4 } },
          { match_id: chutesMatch.id, turn_index: 1, actor_role: 'system', type: 'LADDER', payload: { turn_index: 1, from: 4, to: 14 } },
          { match_id: chutesMatch.id, turn_index: 1, actor_role: 'system', type: 'TURN_END', payload: { turn_index: 1, position_after: 14 } },
      ]
  });

  // Seed Poker Match
  const pokerMatch = await prisma.match.create({
      data: {
          game_type: 'texas_holdem',
          seed: 777,
          status: 'COMPLETED',
          participants: {
              create: [
                  { model_id: chessBotA.id, role: 'seat1' },
                  { model_id: chessBotB.id, role: 'seat2' }
              ]
          }
      }
  });

  await prisma.matchEvent.createMany({
      data: [
          { match_id: pokerMatch.id, turn_index: 0, type: 'MATCH_START', payload: { game_key: 'texas_holdem', seed: 777, starting_stack: 1000 } },
          { match_id: pokerMatch.id, turn_index: 0, type: 'DEAL_HOLE_CARDS', payload: { seat: 1, cards: ['As', 'Kd'] } },
          { match_id: pokerMatch.id, turn_index: 0, type: 'DEAL_HOLE_CARDS', payload: { seat: 2, cards: ['Qq', 'Jj'] } }, // Simplified mock cards
          { match_id: pokerMatch.id, turn_index: 0, type: 'POST_BLINDS', payload: { sb_seat: 1, bb_seat: 2, amounts: [5, 10] } },
          { match_id: pokerMatch.id, turn_index: 1, type: 'BETTING_ROUND_START', payload: { round: 'preflop' } },
          { match_id: pokerMatch.id, turn_index: 2, actor_role: 'seat1', type: 'PLAYER_ACTION', payload: { seat: 1, action: 'raise', amount: 20, stack_after: 975 } },
          { match_id: pokerMatch.id, turn_index: 3, actor_role: 'seat2', type: 'PLAYER_ACTION', payload: { seat: 2, action: 'call', amount: 15, stack_after: 975 } },
          { match_id: pokerMatch.id, turn_index: 4, type: 'DEAL_COMMUNITY', payload: { round: 'flop', cards: ['Ad', 'Ks', '2c'] } },
          { match_id: pokerMatch.id, turn_index: 5, actor_role: 'seat2', type: 'PLAYER_ACTION', payload: { seat: 2, action: 'check', stack_after: 975 } },
          { match_id: pokerMatch.id, turn_index: 6, actor_role: 'seat1', type: 'PLAYER_ACTION', payload: { seat: 1, action: 'bet', amount: 50, stack_after: 925 } },
          { match_id: pokerMatch.id, turn_index: 7, actor_role: 'seat2', type: 'PLAYER_ACTION', payload: { seat: 2, action: 'call', amount: 50, stack_after: 925 } },
          { match_id: pokerMatch.id, turn_index: 8, type: 'SHOWDOWN', payload: {} },
          { match_id: pokerMatch.id, turn_index: 9, type: 'POT_AWARDED', payload: { seat: 1, amount: 150 } },
      ]
  });

  // Seed Blackjack Match
  const blackjackMatch = await prisma.match.create({
      data: {
          game_type: 'blackjack',
          seed: 555,
          status: 'COMPLETED',
          participants: {
              create: [
                  { model_id: chessBotA.id, role: 'seat1' }
              ]
          }
      }
  });

  await prisma.matchEvent.createMany({
      data: [
          { match_id: blackjackMatch.id, turn_index: 0, type: 'MATCH_START', payload: { game_key: 'blackjack', seed: 555, player_count: 1, fixed_bet: 10 } },
          { match_id: blackjackMatch.id, turn_index: 0, actor_role: 'system', type: 'DEAL_CARD', payload: { seat: 1, card: 'Jh', visibility: 'private' } },
          { match_id: blackjackMatch.id, turn_index: 0, actor_role: 'system', type: 'DEAL_DEALER', payload: { cards: ['Ts'], visibility: 'visible' } },
          { match_id: blackjackMatch.id, turn_index: 0, actor_role: 'system', type: 'DEAL_CARD', payload: { seat: 1, card: '7d', visibility: 'private' } },
          { match_id: blackjackMatch.id, turn_index: 1, actor_role: 'seat1', type: 'PLAYER_ACTION', payload: { seat: 1, action: 'hit' } },
          { match_id: blackjackMatch.id, turn_index: 1, actor_role: 'system', type: 'DEAL_CARD', payload: { seat: 1, card: '2c' } },
          { match_id: blackjackMatch.id, turn_index: 2, actor_role: 'seat1', type: 'PLAYER_ACTION', payload: { seat: 1, action: 'stand' } },
          { match_id: blackjackMatch.id, turn_index: 2, actor_role: 'system', type: 'PLAYER_TURN_END', payload: { seat: 1, result: 'active' } },
          { match_id: blackjackMatch.id, turn_index: 3, actor_role: 'system', type: 'DEALER_REVEAL', payload: { cards: ['Ts', '6h'] } },
          { match_id: blackjackMatch.id, turn_index: 3, actor_role: 'system', type: 'DEALER_ACTION', payload: { action: 'hit', card: '5d', hand_value: 21 } },
          { match_id: blackjackMatch.id, turn_index: 3, actor_role: 'system', type: 'DEALER_ACTION', payload: { action: 'stand', hand_value: 21 } },
          { match_id: blackjackMatch.id, turn_index: 4, actor_role: 'system', type: 'HAND_RESULT', payload: { seat: 1, outcome: 'loss', payout_delta: -10, stack_after: 990 } },
      ]
  });

  console.log({ modelA, modelB, modelC, chessBotA, chessBotB, chutesMatch, pokerMatch, blackjackMatch });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
