import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';
import { Chess } from 'chess.js';

export class ChessGame implements GameEngine {
  gameType = 'chess';
  private chess: Chess;
  private maxPlies = 200;

  constructor() {
    this.chess = new Chess();
  }

  initialize(seed: number, options?: { startFen?: string; maxPlies?: number; allowDraws?: boolean; timeControlMinutes?: number; incrementSeconds?: number }): GameEvent[] {
    // We can use the seed to potentially randomize the starting position (Fischer Random) in the future.
    const maxPlies = options?.maxPlies && options.maxPlies > 20 ? options.maxPlies : this.maxPlies;
    this.maxPlies = maxPlies;
    if (options?.startFen && options.startFen !== 'start') {
      try {
        this.chess.load(options.startFen);
      } catch (err) {
        this.chess.reset();
      }
    } else {
      this.chess.reset();
    }
    
    return [
      {
        turn: 0,
        actor: 'system',
        type: 'MATCH_START',
        payload: {
          game_key: 'chess',
          seed,
          ruleset_version: '1.0.0',
          start_fen: this.chess.fen(),
          max_plies: this.maxPlies,
          allow_draws: options?.allowDraws !== false,
          time_control_minutes: options?.timeControlMinutes,
          increment_seconds: options?.incrementSeconds
        }
      }
    ];
  }

  getSystemPrompt(role: string): string {
    return `You are a chess engine playing as ${role}. 
The current board state is provided in FEN format.
The history of moves is provided in SAN.
Your goal is to win the game.
You must output your move in UCI format (e.g., "e2e4", "a7a8q").
Do not provide explanations, just the move.`;
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null } {
    // Reconstruct state from history to ensure purity (or just trust the internal state since this is a transient runner)
    // For safety in a long-running process, we'll sync internal state to history's last FEN if needed, 
    // but here we assume the runner instance persists for the match duration.
    
    const turnIndex = history[history.length - 1].turn + 1;
    const sideToMove = this.chess.turn() === 'w' ? 'white' : 'black';
    
    // Validate it's the correct actor's turn
    if (move.actor !== sideToMove) {
        // Technically this shouldn't happen if the worker orchestrates correctly,
        // but if it does, it's a system error, not necessarily a player forfeit unless we strictly enforce it.
    }

    const fenBefore = this.chess.fen();
    let moveObj;
    let illegalReason = null;

    // 1. Parse Move
    try {
        // clean input
        const cleanContent = move.content.trim().split(/\s+/)[0]; // Take first token
        // Try UCI first
        moveObj = this.chess.move(cleanContent, { strict: false }); 
        
        // If strict UCI fails, chess.js move() handles SAN automatically too, 
        // but we want to know if it was UCI or SAN for logging? 
        // chess.js 'move' accepts string SAN or object. 
        // Let's rely on chess.js's broad parsing for now.
    } catch (e) {
        illegalReason = 'Parse error or illegal move';
    }

    const events: GameEvent[] = [];

    if (!moveObj) {
        // ILLEGAL MOVE
        events.push({
            turn: turnIndex,
            actor: move.actor,
            type: 'ILLEGAL_MOVE',
            payload: {
                side: sideToMove,
                raw_text: move.content,
                reason: illegalReason || 'Invalid move per chess rules',
                fen_before: fenBefore
            }
        });

        return {
            events,
            result: {
                isFinished: true,
                scores: sideToMove === 'white' ? { white: 0, black: 1 } : { white: 1, black: 0 },
                winnerId: sideToMove === 'white' ? 'black' : 'white'
            }
        };
    }

    // 2. Valid Move - Record it
    events.push({
        turn: turnIndex,
        actor: move.actor,
        type: 'MOVE',
        payload: {
            side: sideToMove,
            uci: moveObj.lan, // LAN is closest to UCI in chess.js (long algebraic), or we construct from/to
            san: moveObj.san,
            fen_before: fenBefore,
            fen_after: this.chess.fen(),
            legal: true
        }
    });

    // 3. Check Terminal Conditions
    if (this.chess.isGameOver()) {
        let outcome = '1/2-1/2';
        let winner = null;
        let reason = '';
        const scores = { white: 0.5, black: 0.5 };

        if (this.chess.isCheckmate()) {
            winner = sideToMove; // The one who just moved won? No, side to move NOW is the loser.
            // Wait, chess.turn() flips after .move().
            // So if White moves and mates, turn is Black, and isCheckmate is true.
            // So winner is the PREVIOUS side.
            winner = sideToMove; // This variable holds who moved *this turn*.
            outcome = winner === 'white' ? '1-0' : '0-1';
            reason = 'checkmate';
            scores[winner as 'white'|'black'] = 1;
            scores[winner === 'white' ? 'black' : 'white'] = 0;
        } else if (this.chess.isDraw()) {
            reason = 'draw'; 
            if (this.chess.isStalemate()) reason = 'stalemate';
            if (this.chess.isThreefoldRepetition()) reason = 'repetition';
            if (this.chess.isInsufficientMaterial()) reason = 'insufficient_material';
        }

        events.push({
            turn: turnIndex, // Same turn as the move? Or next? Usually events are sequential.
            actor: 'system',
            type: 'RESULT',
            payload: {
                outcome,
                winner,
                reason,
                final_fen: this.chess.fen(),
                total_plies: turnIndex
            }
        });

        return {
            events,
            result: {
                isFinished: true,
                scores,
                winnerId: winner || undefined
            }
        };
    }

    // 4. Max Plies Check
    if (turnIndex >= this.maxPlies) {
         events.push({
            turn: turnIndex,
            actor: 'system',
            type: 'RESULT',
            payload: {
                outcome: '1/2-1/2',
                winner: null,
                reason: 'max_plies_draw',
                final_fen: this.chess.fen(),
                total_plies: turnIndex
            }
        });
        return {
            events,
            result: {
                isFinished: true,
                scores: { white: 0.5, black: 0.5 },
                winnerId: undefined
            }
        };
    }

    return { events, result: null };
  }
}
