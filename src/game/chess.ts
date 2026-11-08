import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';
import { Chess } from 'chess.js';

export class ChessGame implements GameEngine {
  gameType = 'chess';
  private chess: Chess;
  private maxPlies = 200;
  private plies = 0;

  constructor() {
    this.chess = new Chess();
  }

  initialize(seed: number, options?: { startFen?: string; maxPlies?: number; allowDraws?: boolean; timeControlMinutes?: number; incrementSeconds?: number }): GameEvent[] {
    // We can use the seed to potentially randomize the starting position (Fischer Random) in the future.
    const maxPlies = options?.maxPlies && options.maxPlies > 20 ? options.maxPlies : this.maxPlies;
    this.maxPlies = maxPlies;
    this.plies = 0;
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
          // 1.1.0: models receive a compact observation (SAN move list + current FEN) instead of the full event log.
          ruleset_version: '1.1.0',
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

  getRandomMove(gameState: GameEvent[], role: string): PlayerMove {
    const moves = this.chess.moves({ verbose: true });
    if (moves.length === 0) return { actor: role, content: 'resign' };
    const randomMove = moves[Math.floor(Math.random() * moves.length)];
    return { actor: role, content: `${randomMove.from}${randomMove.to}${randomMove.promotion || ''}` };
  }

  /**
   * What a model is shown. The full event log repeats two FEN strings per move, so prompt size grows with
   * the square of the game length (about 1.4M tokens for a 200-ply game); the SAN list plus the current
   * position carries the same information in about 3% of that.
   */
  getObservation(history: GameEvent[], role: string): GameEvent[] {
    const start = history.find(e => e.type === 'MATCH_START');
    const moves = history.filter(e => e.type === 'MOVE');
    const startFen: string = start?.payload?.start_fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const currentFen: string = moves.length ? moves[moves.length - 1].payload.fen_after : startFen;
    const [, turn = 'w', , , , full = '1'] = startFen.split(' ');
    let moveNumber = parseInt(full, 10) || 1;
    let whiteToMove = turn === 'w';
    const parts: string[] = [];
    moves.forEach((event, index) => {
      if (whiteToMove) parts.push(`${moveNumber}.`);
      else if (index === 0) parts.push(`${moveNumber}...`);
      parts.push(String(event.payload.san));
      if (!whiteToMove) moveNumber++;
      whiteToMove = !whiteToMove;
    });
    const sideToMove = currentFen.split(' ')[1] === 'b' ? 'black' : 'white';
    const lastTurn = history[history.length - 1]?.turn ?? 0;
    const compactStart: GameEvent = start
      ? { ...start, payload: { game_key: 'chess', start_fen: startFen, max_plies: start.payload.max_plies } }
      : { turn: 0, actor: 'system', type: 'MATCH_START', payload: { game_key: 'chess', start_fen: startFen } };
    return [
      compactStart,
      {
        turn: lastTurn,
        actor: 'system',
        type: 'POSITION',
        payload: {
          content: `Moves so far: ${parts.length ? parts.join(' ') : '(none)'}\nCurrent position (FEN): ${currentFen}\nSide to move: ${sideToMove}. You are ${role}.`,
          current_fen: currentFen,
          ply: moves.length
        }
      }
    ];
  }

  getActiveRole(): string {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  private parseMove(raw: string) {
    const token = raw.trim().split(/\s+/)[0] || '';
    const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(token);
    if (uci) {
      return this.chess.move({ from: uci[1].toLowerCase(), to: uci[2].toLowerCase(), promotion: uci[3]?.toLowerCase() });
    }
    return this.chess.move(token);
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null } {
    // Reconstruct state from history to ensure purity (or just trust the internal state since this is a transient runner)
    // For safety in a long-running process, we'll sync internal state to history's last FEN if needed, 
    // but here we assume the runner instance persists for the match duration.
    
    const turnIndex = (history[history.length - 1]?.turn ?? 0) + 1;
    const sideToMove = this.chess.turn() === 'w' ? 'white' : 'black';
    
    const fenBefore = this.chess.fen();
    let moveObj;
    let illegalReason: string | null = null;

    if (move.actor !== sideToMove) {
        illegalReason = `Out of turn: ${move.actor} moved while ${sideToMove} was to move`;
    } else {
        try {
            moveObj = this.parseMove(move.content);
        } catch (e) {
            illegalReason = 'Parse error or illegal move';
        }
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

        const forfeitWinner = sideToMove === 'white' ? 'black' : 'white';
        events.push({
            turn: turnIndex,
            actor: 'system',
            type: 'RESULT',
            payload: {
                outcome: forfeitWinner === 'white' ? '1-0' : '0-1',
                winner: forfeitWinner,
                reason: 'illegal_move',
                final_fen: fenBefore,
                total_plies: this.plies
            }
        });

        return {
            events,
            result: {
                isFinished: true,
                scores: sideToMove === 'white' ? { white: 0, black: 1 } : { white: 1, black: 0 },
                winnerId: forfeitWinner
            }
        };
    }

    // 2. Valid Move - Record it
    this.plies += 1;
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
                total_plies: this.plies
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
    if (this.plies >= this.maxPlies) {
         events.push({
            turn: turnIndex,
            actor: 'system',
            type: 'RESULT',
            payload: {
                outcome: '1/2-1/2',
                winner: null,
                reason: 'max_plies_draw',
                final_fen: this.chess.fen(),
                total_plies: this.plies
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
