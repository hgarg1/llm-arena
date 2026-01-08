import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';

export class ChutesLaddersGame implements GameEngine {
  gameType = 'chutes_and_ladders';
  private currentPosition = 0; // 0 means off-board, 1-100 are squares
  private rngState: number;
  private maxTurns = 200;
  private boardSize = 100;
  private winExact = false;

  // Standard Milton Bradley layout
  private baseTransitions: Record<number, number> = {
    // Ladders (Up)
    1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100,
    // Chutes (Down)
    16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78
  };
  private transitions: Record<number, number> = {};

  constructor() {
    this.rngState = 1;
  }

  // Simple LCG for deterministic RNG
  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return Math.abs(this.rngState);
  }

  private rollDie(): number {
    return (this.rand() % 6) + 1;
  }

  initialize(seed: number, options?: { boardSize?: number; winExact?: boolean; chutesEnabled?: boolean; laddersEnabled?: boolean }): GameEvent[] {
    this.rngState = seed;
    this.currentPosition = 0; // Start off-board
    this.boardSize = Math.max(25, Math.min(200, options?.boardSize || 100));
    this.winExact = options?.winExact === true;
    const chutesEnabled = options?.chutesEnabled !== false;
    const laddersEnabled = options?.laddersEnabled !== false;
    this.transitions = {};
    Object.entries(this.baseTransitions).forEach(([fromKey, toValue]) => {
      const from = parseInt(fromKey, 10);
      if (from > this.boardSize || toValue > this.boardSize) return;
      if (toValue > from && !laddersEnabled) return;
      if (toValue < from && !chutesEnabled) return;
      this.transitions[from] = toValue;
    });

    return [
      {
        turn: 0,
        actor: 'system',
        type: 'MATCH_START',
        payload: {
          game_key: 'chutes_and_ladders',
          seed,
          ruleset_version: '1.0.0',
          engine_version: '1.0.0',
          board_definition_hash: 'MB_STANDARD',
          board_size: this.boardSize,
          win_exact: this.winExact,
          chutes_enabled: chutesEnabled,
          ladders_enabled: laddersEnabled
        }
      }
    ];
  }

  getSystemPrompt(role: string): string {
    return `You are playing Chutes and Ladders.
You are currently at square ${this.currentPosition}.
The game is played on a 10x10 grid from 1 to 100.
Your goal is to reach square 100 or greater.
You do not make decisions; the dice determines your move.
Please acknowledge the game state.`;
  }

  getRandomMove(gameState: GameEvent[], role: string): PlayerMove {
    return { actor: role, content: 'ACK' };
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null } {
    const turnIndex = (history[history.length - 1]?.turn ?? 0) + 1;
    const events: GameEvent[] = [];

    // Check strict turn limit
    if (turnIndex > this.maxTurns) {
       return {
            events: [{
                turn: turnIndex,
                actor: 'system',
                type: 'RESULT',
                payload: { outcome: 'draw', reason: 'max_turns', final_position: this.currentPosition, total_turns: turnIndex }
            }],
            result: {
                isFinished: true,
                scores: { player1: 0.5 },
                winnerId: undefined
            }
       };
    }

    // 1. TURN_START
    events.push({
        turn: turnIndex,
        actor: 'system',
        type: 'TURN_START',
        payload: { turn_index: turnIndex, position_before: this.currentPosition }
    });

    // 2. DICE_ROLL
    const roll = this.rollDie();
    events.push({
        turn: turnIndex,
        actor: 'system',
        type: 'DICE_ROLL',
        payload: { turn_index: turnIndex, roll }
    });

    // 3. MOVE calculation
    const from = this.currentPosition;
    let to = from + roll;
    const overshoot = to > this.boardSize;
    if (overshoot && this.winExact) {
        to = from;
    }

    events.push({
        turn: turnIndex,
        actor: 'system', // The system moves the piece
        type: 'MOVE',
        payload: { turn_index: turnIndex, from, to, overshoot }
    });

    this.currentPosition = to;

    // 4. Check Chutes/Ladders
    if (this.currentPosition <= this.boardSize && this.transitions[this.currentPosition]) {
        const afterTransition = this.transitions[this.currentPosition];
        const isLadder = afterTransition > this.currentPosition;
        
        events.push({
            turn: turnIndex,
            actor: 'system',
            type: isLadder ? 'LADDER' : 'CHUTE',
            payload: { turn_index: turnIndex, from: this.currentPosition, to: afterTransition }
        });
        
        this.currentPosition = afterTransition;
    }

    // 5. TURN_END
    events.push({
        turn: turnIndex,
        actor: 'system',
        type: 'TURN_END',
        payload: { turn_index: turnIndex, position_after: this.currentPosition }
    });

    // 6. Check Win Condition
    if (this.currentPosition >= this.boardSize) {
        events.push({
            turn: turnIndex,
            actor: 'system',
            type: 'RESULT',
            payload: {
                outcome: 'win',
                winner: move.actor,
                final_position: this.currentPosition,
                total_turns: turnIndex
            }
        });

        return {
            events,
            result: {
                isFinished: true,
                scores: { [move.actor]: 1 },
                winnerId: move.actor
            }
        };
    }

    return { events, result: null };
  }
}
