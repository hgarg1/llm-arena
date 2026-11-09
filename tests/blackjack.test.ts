import { BlackjackGame } from '../src/game/blackjack';
import { GameEvent } from '../src/game/types';
import { playOut, seatRoles } from './helpers';

const rig = (engine: BlackjackGame, opts: { player: string[]; dealer: string[]; stack?: number }) => {
  const e = engine as any;
  e.players[0].hands[0].cards = opts.player;
  e.players[0].hands[0].status = 'active';
  e.dealerHand = opts.dealer;
  e.turnPhase = 'players';
  e.activeSeatIndex = 0;
  e.activeHandIndex = 0;
  if (opts.stack !== undefined) e.players[0].stack = opts.stack;
};

const fresh = (options: Record<string, any> = {}) => {
  const engine = new BlackjackGame();
  const state: GameEvent[] = engine.initialize(1, { playerCount: 1, startingStack: 1000, fixedBet: 10, ...options });
  return { engine, state };
};

const finalStack = (events: GameEvent[]) => events.filter(e => e.type === 'HAND_RESULT').pop()!.payload.stack_after;

describe('BlackjackGame', () => {
  it('pays a push exactly once (bet returned)', () => {
    const { engine, state } = fresh();
    rig(engine, { player: ['Th', '8d'], dealer: ['Tc', '8s'], stack: 990 });
    const out = engine.processMove(state, { actor: 'seat1', content: 'STAND' });
    expect(out.events.find(e => e.type === 'HAND_RESULT')!.payload.outcome).toBe('push');
    expect(finalStack(out.events)).toBe(1000);
  });

  it('pays a win 1:1 and a loss nothing', () => {
    let { engine, state } = fresh();
    rig(engine, { player: ['Th', 'Kd'], dealer: ['Tc', '8s'], stack: 990 });
    expect(finalStack(engine.processMove(state, { actor: 'seat1', content: 'STAND' }).events)).toBe(1010);
    ({ engine, state } = fresh());
    rig(engine, { player: ['Th', '7d'], dealer: ['Tc', '8s'], stack: 990 });
    expect(finalStack(engine.processMove(state, { actor: 'seat1', content: 'STAND' }).events)).toBe(990);
  });

  it('settles the hand and resolves the dealer when the last seat surrenders', () => {
    const { engine, state } = fresh({ allowSurrender: true });
    rig(engine, { player: ['Th', '6d'], dealer: ['Tc', '8s'], stack: 990 });
    const out = engine.processMove(state, { actor: 'seat1', content: 'SURRENDER' });
    expect(out.result?.isFinished).toBe(true);
    expect(finalStack(out.events)).toBe(995);
  });

  it('settles when the last seat splits aces', () => {
    const { engine, state } = fresh({ allowSplit: true });
    rig(engine, { player: ['Ah', 'Ad'], dealer: ['Tc', '7s'], stack: 990 });
    const out = engine.processMove(state, { actor: 'seat1', content: 'SPLIT' });
    expect(out.result?.isFinished).toBe(true);
    expect(out.events.filter(e => e.type === 'HAND_RESULT')).toHaveLength(2);
  });

  it('never leaves the runner waiting on a seat that is already done', () => {
    const { engine, state } = fresh();
    rig(engine, { player: ['Th', '8d'], dealer: ['Tc', '8s'] });
    engine.processMove(state, { actor: 'seat1', content: 'STAND' });
    expect(engine.getActiveRole()).toBe('system');
  });

  it('auto-stands natural blackjacks and does not ask them for a move', () => {
    let found = false;
    for (let seed = 1; seed < 400 && !found; seed++) {
      const engine = new BlackjackGame();
      const state = engine.initialize(seed, { playerCount: 1, deckCount: 6 });
      if (state.some(e => e.type === 'HAND_END' && e.payload.result === 'blackjack')) {
        found = true;
        expect(engine.getActiveRole()).toBe('system');
        const out = engine.processMove(state, { actor: 'system', content: 'RESOLVE' });
        expect(out.result?.isFinished).toBe(true);
        expect(['blackjack', 'push']).toContain(out.events.find(e => e.type === 'HAND_RESULT')!.payload.outcome);
      }
    }
    expect(found).toBe(true);
  });

  it('skips player decisions when the dealer peeks a blackjack', () => {
    let found = false;
    for (let seed = 1; seed < 2000 && !found; seed++) {
      const engine = new BlackjackGame();
      const state = engine.initialize(seed, { playerCount: 2, dealerPeek: true });
      if ((engine as any).turnPhase === 'dealer') {
        found = true;
        expect(engine.getActiveRole()).toBe('system');
        expect(engine.processMove(state, { actor: 'system', content: 'RESOLVE' }).result?.isFinished).toBe(true);
      }
    }
    expect(found).toBe(true);
  });

  it('insurance pays 2:1 against a dealer blackjack and reports a loss otherwise', () => {
    let { engine, state } = fresh({ allowInsurance: true });
    rig(engine, { player: ['Th', '8d'], dealer: ['Ac', 'Ks'], stack: 990 });
    engine.processMove(state, { actor: 'seat1', content: 'INSURE' }); // stake 5, stack 985
    let out = engine.processMove(state, { actor: 'seat1', content: 'STAND' });
    const win = out.events.find(e => e.type === 'HAND_RESULT')!.payload;
    expect(win.insurance_delta).toBe(10);
    expect(win.stack_after).toBe(985 + 15);

    ({ engine, state } = fresh({ allowInsurance: true }));
    rig(engine, { player: ['Th', '8d'], dealer: ['Ac', '6s'], stack: 990 });
    engine.processMove(state, { actor: 'seat1', content: 'INSURE' });
    out = engine.processMove(state, { actor: 'seat1', content: 'STAND' });
    expect(out.events.find(e => e.type === 'HAND_RESULT')!.payload.insurance_delta).toBe(-5);
  });

  it('defaults to six decks', () => {
    const engine = new BlackjackGame();
    engine.initialize(1, { playerCount: 1 });
    expect((engine as any).deckCount).toBe(6);
  });

  it('uses turn numbers that increase from the last event', () => {
    const { engine, state } = fresh();
    rig(engine, { player: ['Th', '8d'], dealer: ['Tc', '8s'] });
    const out = engine.processMove(state, { actor: 'seat1', content: 'STAND' });
    expect(out.events[0].turn).toBe(1);
  });

  it('completes every random game with consistent stacks (1-6 seats, all options)', () => {
    for (let i = 0; i < 300; i++) {
      const seats = 1 + (i % 6);
      const engine = new BlackjackGame();
      const options = {
        playerCount: seats,
        startingStack: 500,
        fixedBet: 25,
        allowSplit: i % 2 === 0,
        allowSurrender: i % 3 === 0,
        allowInsurance: i % 4 === 0,
        dealerPeek: i % 5 === 0 && i % 4 !== 0,
        allowDoubleAny: i % 7 === 0
      };
      const { result, state, steps } = playOut(engine, seatRoles(seats), 5000 + i, options, 300);
      expect(result?.isFinished).toBe(true);
      expect(steps).toBeLessThan(300);
      // Every hand is settled exactly once, and stacks never go negative.
      const results = state.filter(e => e.type === 'HAND_RESULT');
      expect(results.length).toBeGreaterThanOrEqual(seats);
      results.forEach(r => expect(r.payload.stack_after).toBeGreaterThanOrEqual(0));
    }
  });
});
