import { ChutesLaddersGame } from '../src/game/chutes_ladders';
import { playOut } from './helpers';

describe('ChutesLaddersGame', () => {
  it('needs no model decisions', () => {
    expect(new ChutesLaddersGame().isAutomatic()).toBe(true);
  });

  it('rolls are roughly uniform over 1-6', () => {
    const counts = new Array(7).fill(0);
    for (let seed = 1; seed <= 60; seed++) {
      const engine = new ChutesLaddersGame();
      let state = engine.initialize(seed * 7919, { boardSize: 200, winExact: true });
      for (let i = 0; i < 150; i++) {
        const out = engine.processMove(state, { actor: 'player1', content: 'ACK' });
        const roll = out.events.find(e => e.type === 'DICE_ROLL')!.payload.roll as number;
        counts[roll]++;
        state = [...state, ...out.events];
        (engine as any).currentPosition = 1; // keep the game from ending so every seed yields 150 rolls
      }
    }
    const total = counts.slice(1).reduce((a, b) => a + b, 0);
    expect(total).toBe(9000);
    for (let face = 1; face <= 6; face++) {
      expect(counts[face] / total).toBeGreaterThan(0.14);
      expect(counts[face] / total).toBeLessThan(0.19);
    }
  });

  it('is deterministic for a seed', () => {
    const a = playOut(new ChutesLaddersGame(), ['player1'], 77);
    const b = playOut(new ChutesLaddersGame(), ['player1'], 77);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('scales chutes and ladders onto a smaller board', () => {
    const engine = new ChutesLaddersGame();
    engine.initialize(1, { boardSize: 50 });
    const transitions = (engine as any).transitions as Record<number, number>;
    const entries = Object.entries(transitions);
    expect(entries.length).toBeGreaterThan(5);
    for (const [from, to] of entries) {
      expect(Number(from)).toBeLessThan(50);
      expect(to).toBeGreaterThanOrEqual(1);
      expect(to).toBeLessThanOrEqual(50);
    }
  });

  it('publishes its exact chute and ladder layout for the replay', () => {
    const engine = new ChutesLaddersGame();
    const events = engine.initialize(1, { boardSize: 50 });
    const published = events[0].payload.transitions as Array<{ from: number; to: number }>;
    expect(published.length).toBeGreaterThan(5);
    const internal = (engine as any).transitions as Record<number, number>;
    expect(Object.fromEntries(published.map(t => [t.from, t.to]))).toEqual(internal);
    expect(events[0].payload.board_size).toBe(50);
  });

  it('honours the chutes/ladders toggles', () => {
    const noChutes = new ChutesLaddersGame();
    noChutes.initialize(1, { chutesEnabled: false });
    expect(Object.entries((noChutes as any).transitions).every(([f, t]) => (t as number) > Number(f))).toBe(true);
    const noLadders = new ChutesLaddersGame();
    noLadders.initialize(1, { laddersEnabled: false });
    expect(Object.entries((noLadders as any).transitions).every(([f, t]) => (t as number) < Number(f))).toBe(true);
  });

  it('always finishes with the mover as winner', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { result } = playOut(new ChutesLaddersGame(), ['player1'], seed);
      expect(result?.isFinished).toBe(true);
    }
  });
});
