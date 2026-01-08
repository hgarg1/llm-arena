import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';

export class IteratedNegotiationGame implements GameEngine {
  gameType = 'iterated-negotiation';
  private maxRounds = 5;

  initialize(seed: number): GameEvent[] {
    return [
      {
        turn: 0,
        actor: 'system',
        type: 'game_start',
        payload: {
          message: 'Negotiation started. You have 5 rounds to agree on a split of 100 coins.',
          totalCoins: 100,
          maxRounds: this.maxRounds
        }
      }
    ];
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null } {
    const currentTurn = (history[history.length - 1]?.turn ?? 0) + 1;
    const events: GameEvent[] = [];
    
    // Parse move (simple heuristic for MVP: look for numbers)
    // "I propose 60 for me and 40 for you" -> { me: 60, you: 40 }
    
    events.push({
      turn: currentTurn,
      actor: move.actor,
      type: 'message',
      payload: { content: move.content }
    });

    // Check termination condition
    // For MVP, we just run for fixed rounds and score based on agreement keywords or random deterministic logic
    
    // Deterministic logic based on move content length for the Mock
    let score = 0;
    if (move.content.toLowerCase().includes('agree')) {
         score = 50; // Split
    }

    if (currentTurn >= this.maxRounds * 2) {
      return {
        events,
        result: {
          isFinished: true,
          scores: { player1: 50, player2: 50 }, // Draw for MVP simplicity
          winnerId: undefined
        }
      };
    }

    return { events, result: null };
  }

  getSystemPrompt(role: string): string {
    return `You are playing a negotiation game. Your goal is to maximize your share of 100 coins. You are ${role}. Propose splits or accept offers.`;
  }
}
