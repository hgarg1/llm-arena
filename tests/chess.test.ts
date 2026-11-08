import { ChessGame } from '../src/game/chess';
import { GameEvent } from '../src/game/types';
import { playOut } from './helpers';

const start = () => {
  const engine = new ChessGame();
  const history: GameEvent[] = engine.initialize(1, {});
  return { engine, history };
};

describe('ChessGame', () => {
  it('accepts UCI moves and reports the legal move', () => {
    const { engine, history } = start();
    const out = engine.processMove(history, { actor: 'white', content: 'e2e4' });
    expect(out.events[0]).toMatchObject({ type: 'MOVE', payload: { san: 'e4', uci: 'e2e4' } });
    expect(out.result).toBeNull();
  });

  it('accepts SAN moves too', () => {
    const { engine, history } = start();
    expect(engine.processMove(history, { actor: 'white', content: 'Nf3' }).events[0].type).toBe('MOVE');
  });

  it('knows whose turn it is', () => {
    const { engine, history } = start();
    expect(engine.getActiveRole()).toBe('white');
    engine.processMove(history, { actor: 'white', content: 'e2e4' });
    expect(engine.getActiveRole()).toBe('black');
  });

  it('forfeits an illegal move and emits a RESULT event', () => {
    const { engine, history } = start();
    const out = engine.processMove(history, { actor: 'white', content: 'e2e5' });
    expect(out.events.map(e => e.type)).toEqual(['ILLEGAL_MOVE', 'RESULT']);
    expect(out.result).toMatchObject({ isFinished: true, winnerId: 'black', scores: { white: 0, black: 1 } });
  });

  it('treats a move from the wrong side as illegal', () => {
    const { engine, history } = start();
    const out = engine.processMove(history, { actor: 'black', content: 'e7e5' });
    expect(out.events[0].type).toBe('ILLEGAL_MOVE');
    expect(out.events[0].payload.reason).toMatch(/Out of turn/);
  });

  it('detects checkmate (fool\'s mate) for black', () => {
    const { engine, history } = start();
    let state = history;
    let last: any;
    for (const [actor, content] of [['white', 'f2f3'], ['black', 'e7e5'], ['white', 'g2g4'], ['black', 'd8h4']] as const) {
      last = engine.processMove(state, { actor, content });
      state = [...state, ...last.events];
    }
    expect(last.result).toMatchObject({ isFinished: true, winnerId: 'black', scores: { white: 0, black: 1 } });
  });

  it('parses promotion moves', () => {
    const engine = new ChessGame();
    const history = engine.initialize(1, { startFen: '8/P7/8/8/8/8/k6K/8 w - - 0 1' });
    const out = engine.processMove(history, { actor: 'white', content: 'a7a8q' });
    expect(out.events[0]).toMatchObject({ type: 'MOVE', payload: { san: expect.stringContaining('=Q') } });
  });

  it('random moves are legal UCI and games always terminate', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { result, state } = playOut(new ChessGame(), ['white', 'black'], seed, { maxPlies: 60 });
      expect(result?.isFinished).toBe(true);
      expect(state.some(e => e.type === 'ILLEGAL_MOVE')).toBe(false);
      expect(state[state.length - 1].type).toBe('RESULT');
    }
  });

  it('counts plies itself, not event turn numbers', () => {
    const { state } = playOut(new ChessGame(), ['white', 'black'], 3, { maxPlies: 30 });
    const result = state[state.length - 1];
    expect(result.payload.total_plies).toBeLessThanOrEqual(30);
  });

  describe('compact observation', () => {
    const play = (contents: string[], options: any = {}) => {
      const engine = new ChessGame();
      const history: GameEvent[] = engine.initialize(1, options);
      contents.forEach(content => history.push(...engine.processMove(history, { actor: engine.getActiveRole(), content }).events));
      return { engine, history };
    };

    it('shows the SAN move list with move numbers and the current FEN', () => {
      const { engine, history } = play(['e2e4', 'e7e5', 'g1f3']);
      const obs = engine.getObservation(history, 'black');
      const text = obs[obs.length - 1].payload.content as string;
      expect(text).toContain('Moves so far: 1. e4 e5 2. Nf3');
      expect(text).toContain('Side to move: black. You are black.');
      expect(obs[obs.length - 1].payload.current_fen).toBe(history.filter(e => e.type === 'MOVE').pop()!.payload.fen_after);
    });

    it('handles the first move and an empty game', () => {
      const { engine, history } = play([]);
      const text = engine.getObservation(history, 'white').pop()!.payload.content as string;
      expect(text).toContain('Moves so far: (none)');
      expect(text).toContain('Side to move: white');
    });

    it('numbers correctly when black moves first (custom FEN)', () => {
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 7';
      const { engine, history } = play(['e7e5', 'g1f3'], { startFen: fen });
      const text = engine.getObservation(history, 'white').pop()!.payload.content as string;
      expect(text).toContain('Moves so far: 7... e5 8. Nf3');
    });

    it('is a tiny fraction of the full log for a long game, and grows linearly', () => {
      const { engine, history } = (() => {
        const e = new ChessGame();
        const h: GameEvent[] = e.initialize(3, { maxPlies: 120 });
        for (let i = 0; i < 100; i++) {
          const role = e.getActiveRole();
          const out = e.processMove(h, e.getRandomMove(h, role));
          h.push(...out.events);
          if (out.result) break;
        }
        return { engine: e, history: h };
      })();
      const full = JSON.stringify(history).length;
      const compact = JSON.stringify(engine.getObservation(history, 'white')).length;
      expect(compact).toBeLessThan(full / 15);
    });

    it('does not leak anything the model could not already see, and keeps the ruleset version bumped', () => {
      const { engine, history } = play(['e2e4']);
      const obs = engine.getObservation(history, 'black');
      expect(obs.map(e => e.type)).toEqual(['MATCH_START', 'POSITION']);
      expect(history[0].payload.ruleset_version).toBe('1.1.0');
    });
  });
});
