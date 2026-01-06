import { Worker } from 'bullmq';
import { redisConnection } from './config/redis';
import { prisma } from './config/db';
import { MatchRepository } from './repositories/match.repository';
import { IteratedNegotiationGame } from './game/negotiation';
import { getModelAdapter } from './game/adapters';
import { MatchStatus } from '@prisma/client';

const matchRepo = new MatchRepository();

const worker = new Worker('match-queue', async job => {
  console.log(`Processing match ${job.data.matchId}`);
  const { matchId } = job.data;

  const match = await matchRepo.findById(matchId);
  if (!match) throw new Error('Match not found');

  // Update status to RUNNING
  await matchRepo.updateStatus(matchId, MatchStatus.RUNNING);

  try {
    const game = new IteratedNegotiationGame(); // In future, select based on match.game_type
    let gameState = game.initialize(match.seed);

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
      role: `player${match.participants.indexOf(p) + 1}` // simple role assignment
    }));

    let result = null;
    let turnCount = 0;
    const MAX_TURNS = 20; // Safety break

    while (!result && turnCount < MAX_TURNS) {
      // Determine whose turn it is
      // For this simple game, we'll just alternate or let the engine decide
      // But the engine currently expects a move.
      // Let's cycle through players.
      
      const activePlayerIndex = turnCount % adapters.length;
      const activePlayer = adapters[activePlayerIndex];
      
      const systemPrompt = game.getSystemPrompt(activePlayer.role);
      
      // Call Model
      const moveContent = await activePlayer.adapter.generateMove(systemPrompt, gameState);

      // Process Move
      const step = game.processMove(gameState, {
        actor: activePlayer.role,
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

}, { connection: redisConnection as any });

worker.on('completed', job => {
  console.log(`Job ${job.id} has completed!`);
});

worker.on('failed', (job, err) => {
  console.log(`Job ${job?.id} has failed with ${err.message}`);
});

console.log('Worker started...');
