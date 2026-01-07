import { Worker } from 'bullmq';
import { redisConnection } from './config/redis';
import { MatchRepository } from './repositories/match.repository';
import { getGameEngine } from './game/registry';
import { getModelAdapter } from './game/adapters';
import { MatchStatus } from '@prisma/client';
import { settingsService } from './services/settings.service';
import { matchQueue } from './services/queue';

const matchRepo = new MatchRepository();

let maxTurns = 250;

const startWorker = async () => {
  const settings = await settingsService.getAll();
  const concurrency = Math.max(1, parseInt(settings.queue_concurrency || '2', 10));
  maxTurns = Math.max(1, parseInt(settings.queue_max_turns || '250', 10));

  const worker = new Worker('match-queue', async job => {
  console.log(`Processing match ${job.data.matchId}`);
  const { matchId, options } = job.data;

  const match = await matchRepo.findById(matchId);
  if (!match) throw new Error('Match not found');

  // Update status to RUNNING
  await matchRepo.updateStatus(matchId, MatchStatus.RUNNING);

  try {
    const game = await getGameEngine(match.game_type);

    // Pass options to initialize (e.g. playerCount, dealerIndex)
    let gameState = (game as any).initialize(match.seed, options); 

    // Persist initial events
    for (const event of gameState) {
      await matchRepo.addEvent({
        match: { connect: { id: matchId } },
        turn_index: event.turn,
        type: event.type,
        actor_role: event.actor,
        payload: event.payload
      });
    }

    // Initialize Adapters
    const adapters = match.participants.map(p => ({
      participantId: p.id,
      adapter: getModelAdapter(p.model.api_provider, p.model.api_model_id),
      role: p.role || `player${match.participants.indexOf(p) + 1}` 
    }));

    let result = null;
    let turnCount = 0;
    while (!result && turnCount < maxTurns) {
      
      let activeRole = '';
      if (match.game_type === 'chess') {
          const moves = gameState.filter((e: any) => e.type === 'MOVE');
          activeRole = moves.length % 2 === 0 ? 'white' : 'black';
      } else if (match.game_type === 'chutes_and_ladders') {
          if (adapters.length > 0) {
              activeRole = adapters[0].role;
          } else {
              activeRole = 'player1'; 
          }
      } else if (match.game_type === 'texas_holdem') {
          activeRole = `seat${(turnCount % 2) + 1}`; 
      } else if (match.game_type === 'blackjack') {
          // Blackjack engine tracks active seat index internally, but worker is stateless loop.
          // We need to query the state or infer.
          // Inference: Count PLAYER_TURN_END events.
          const endedTurns = gameState.filter((e: any) => e.type === 'PLAYER_TURN_END').length;
          // If all players done, next call to processMove handles dealer automatically? 
          // Engine logic: if activeSeatIndex >= count, returns result.
          // So we just need to route to current player.
          // 0 ended -> seat1. 1 ended -> seat2.
          const playerCount = match.participants.length || 1;
          if (endedTurns >= playerCount) {
              activeRole = 'system'; // Hand back to engine for dealer phase
          } else {
              activeRole = `seat${endedTurns + 1}`;
          }
      } else {
          activeRole = `player${(turnCount % 2) + 1}`;
      }

      let moveContent = '';
      
      if (activeRole === 'system') {
          // Engine needs a kick to process dealer logic
          moveContent = 'RESOLVE';
      } else {
          const activePlayer = adapters.find(a => a.role === activeRole);
          
          if (activePlayer) {
              const systemPrompt = game.getSystemPrompt(activePlayer.role);
              moveContent = await activePlayer.adapter.generateMove(systemPrompt, gameState);
          } else {
              console.warn(`No player found for role ${activeRole}, defaulting...`);
              moveContent = 'STAND'; 
          }
      }

      // Process Move
      const step = game.processMove(gameState, {
        actor: activeRole,
        content: moveContent
      });

      // Persist new events
      for (const event of step.events) {
        await matchRepo.addEvent({
          match: { connect: { id: matchId } },
          turn_index: event.turn,
          type: event.type,
          actor_role: event.actor,
          payload: event.payload
        });
        gameState.push(event);
      }

      result = step.result;
      turnCount++;
    }

    // Finish
    await matchRepo.updateStatus(matchId, MatchStatus.COMPLETED, new Date());
    console.log(`Match ${matchId} completed.`);

  } catch (error) {
    console.error(`Match ${matchId} failed:`, error);
    await matchRepo.updateStatus(matchId, MatchStatus.FAILED);
    throw error;
  }

  }, { connection: redisConnection as any, concurrency });

  worker.on('completed', job => {
    console.log(`Job ${job.id} has completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`Job ${job?.id} has failed with ${err.message}`);
  });

  if (settings.queue_auto_clean_enabled === 'true') {
    const intervalMinutes = Math.max(1, parseInt(settings.queue_auto_clean_interval_minutes || '60', 10));
    setInterval(async () => {
      await matchQueue.clean(1000, 100, 'completed');
      await matchQueue.clean(1000, 100, 'failed');
    }, intervalMinutes * 60 * 1000);
  }

  console.log('Worker started...');
};

startWorker().catch(err => {
  console.error('Worker failed to start:', err);
});
