import { Chess } from 'chess.js';
import { GameEvent, ModelAdapter } from '../../src/game/types';

/** A deterministic "model": the move depends only on what it sees, so two runs can be compared exactly. */
export const scriptedAdapter = (): ModelAdapter => ({
  generateMove: async (_prompt, history: GameEvent[], role) => {
    const fen = [...history].reverse().map(e => e.payload?.current_fen || e.payload?.fen_after || e.payload?.start_fen).find(Boolean);
    if (fen) {
      const legal = new Chess(fen).moves({ verbose: true });
      const pick = legal[(history.length * 7 + 3) % legal.length];
      return `${pick.from}${pick.to}${pick.promotion || ''}`;
    }
    const n = history.length;
    if (role!.startsWith('seat')) {
      return ['CALL', 'CHECK', 'RAISE 40', 'HIT', 'STAND', 'CALL', 'FOLD', 'CALL'][n % 8];
    }
    return 'ACK';
  }
});
