import { TexasHoldemGame } from '../src/game/poker';
import { GameEvent } from '../src/game/types';
import { playOut, seatRoles } from './helpers';

const heads = (opts: Record<string, any> = {}) => {
  const engine = new TexasHoldemGame();
  const state: GameEvent[] = engine.initialize(7, { playerCount: 2, dealerIndex: 0, ...opts });
  return { engine, state };
};

const act = (engine: TexasHoldemGame, state: GameEvent[], content: string) => {
  const actor = engine.getActiveRole()!;
  const out = engine.processMove(state, { actor, content });
  state.push(...out.events);
  return out;
};

describe('TexasHoldemGame', () => {
  it('posts blinds and gives the heads-up dealer first action', () => {
    const { engine, state } = heads();
    const blinds = state.find(e => e.type === 'POST_BLINDS')!;
    expect(blinds.payload).toMatchObject({ sb_seat: 1, bb_seat: 2, amounts: [5, 10] });
    expect(engine.getActiveRole()).toBe('seat1');
  });

  it('awards the pot to the last player when the other folds', () => {
    const { engine, state } = heads();
    const out = act(engine, state, 'FOLD');
    expect(out.result).toMatchObject({ isFinished: true, winnerId: 'seat2', scores: { seat1: 0, seat2: 1 } });
    const result = out.events.find(e => e.type === 'RESULT')!;
    expect(result.payload.final_stacks).toEqual([995, 1005]);
  });

  it('credits the winner, not the folder, in scores', () => {
    const { engine, state } = heads();
    const out = act(engine, state, 'FOLD');
    expect(out.result!.scores.seat1).toBe(0);
    expect(out.result!.scores.seat2).toBe(1);
  });

  it('lets the big blind act before the flop is dealt', () => {
    const { engine, state } = heads();
    act(engine, state, 'CALL'); // SB completes
    expect(engine.getActiveRole()).toBe('seat2'); // BB option
    expect(state.some(e => e.type === 'DEAL_COMMUNITY')).toBe(false);
    act(engine, state, 'CHECK');
    expect(state.filter(e => e.type === 'DEAL_COMMUNITY')[0].payload.round).toBe('flop');
  });

  it('re-opens the action after a raise and honours the raise-to amount', () => {
    const { engine, state } = heads();
    act(engine, state, 'RAISE 40');
    const raise = state.filter(e => e.type === 'PLAYER_ACTION').pop()!;
    expect(raise.payload).toMatchObject({ action: 'raise', raise_to: 40, stack_after: 960 });
    expect(engine.getActiveRole()).toBe('seat2');
    act(engine, state, 'CALL');
    expect(state.some(e => e.type === 'DEAL_COMMUNITY')).toBe(true);
  });

  it('post-flop action starts left of the dealer', () => {
    const { engine, state } = heads();
    act(engine, state, 'CALL');
    act(engine, state, 'CHECK');
    expect(engine.getActiveRole()).toBe('seat2'); // heads-up: big blind acts first after the flop
  });

  it('treats an unknown action as a fold with an ILLEGAL_ACTION event', () => {
    const { engine, state } = heads();
    const out = act(engine, state, 'DANCE');
    expect(out.events.map(e => e.type)).toEqual(['ILLEGAL_ACTION', 'PLAYER_ACTION', 'POT_AWARDED', 'RESULT']);
  });

  it('does not allow CHECK while facing a bet', () => {
    const { engine, state } = heads();
    const out = act(engine, state, 'CHECK');
    expect(out.events[0].type).toBe('ILLEGAL_ACTION');
  });

  it('handles all-in, runs the board out and conserves chips', () => {
    const { engine, state } = heads({ startingStack: 100 });
    act(engine, state, 'ALL-IN');
    const out = act(engine, state, 'CALL');
    expect(out.result?.isFinished).toBe(true);
    expect(state.filter(e => e.type === 'DEAL_COMMUNITY').map(e => e.payload.round)).toEqual(['flop', 'turn', 'river']);
    const stacks = out.events.find(e => e.type === 'RESULT')!.payload.final_stacks as number[];
    expect(stacks.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it('turns a short call into an all-in call instead of an illegal fold', () => {
    const { engine, state } = heads({ startingStack: 100, bigBlind: 10, smallBlind: 5 });
    act(engine, state, 'RAISE 100'); // seat1 shoves
    const out = act(engine, state, 'CALL');
    expect(out.events.find(e => e.type === 'ILLEGAL_ACTION')).toBeUndefined();
    expect(out.result?.isFinished).toBe(true);
  });

  it('builds side pots when stacks differ', () => {
    const engine = new TexasHoldemGame();
    const state: GameEvent[] = engine.initialize(11, { playerCount: 3, dealerIndex: 2, startingStack: 300 });
    const players = (engine as any).players as any[];
    // Stacks net of the posted blinds (seat1 SB=5, seat2 BB=10): 100 / 300 / 300 chips in play in total 700.
    players[0].stack = 95;
    players[1].stack = 290;
    players[2].stack = 300;
    // seat1 is SB, seat2 BB, seat3 (dealer) acts first
    const out = [] as any[];
    out.push(act(engine, state, 'ALL-IN')); // dealer shoves 300
    out.push(act(engine, state, 'ALL-IN')); // seat1 SB all-in for 100 total (short)
    const last = act(engine, state, 'CALL'); // BB calls
    expect(last.result?.isFinished).toBe(true);
    const awards = state.filter(e => e.type === 'POT_AWARDED');
    expect(awards.length).toBeGreaterThanOrEqual(2); // main pot + side pot
    const stacks = last.events.find(e => e.type === 'RESULT')!.payload.final_stacks as number[];
    expect(stacks.reduce((a, b) => a + b, 0)).toBe(700);
  });

  it('only shows a player their own hole cards', () => {
    const { engine, state } = heads();
    const seat1 = engine.getObservation(state, 'seat1').filter(e => e.type === 'DEAL_HOLE_CARDS');
    expect(seat1).toHaveLength(1);
    expect(seat1[0].payload.seat).toBe(1);
    expect(engine.getObservation(state, 'seat2').filter(e => e.type === 'DEAL_HOLE_CARDS')[0].payload.seat).toBe(2);
    expect(JSON.stringify(engine.getObservation(state, 'seat1'))).not.toContain(
      JSON.stringify(state.find(e => e.type === 'DEAL_HOLE_CARDS' && e.payload.seat === 2)!.payload.cards)
    );
  });

  it('resets all hand state when re-initialised', () => {
    const engine = new TexasHoldemGame();
    playOut(engine, seatRoles(2), 5, { playerCount: 2 });
    const events = engine.initialize(5, { playerCount: 2 });
    expect(events.filter(e => e.type === 'DEAL_COMMUNITY')).toHaveLength(0);
    expect((engine as any).communityCards).toHaveLength(0);
    expect(engine.getActiveRole()).not.toBeNull();
  });

  it('handles blinds larger than the stack (auto-resolves)', () => {
    const engine = new TexasHoldemGame();
    const state: GameEvent[] = engine.initialize(3, { playerCount: 2, startingStack: 5, smallBlind: 5, bigBlind: 10, dealerIndex: 0 });
    expect(engine.getActiveRole()).toBe('system');
    const out = engine.processMove(state, { actor: 'system', content: 'RESOLVE' });
    expect(out.result?.isFinished).toBe(true);
  });

  it('conserves chips and terminates across 400 random games of 2-9 players', () => {
    for (let i = 0; i < 400; i++) {
      const players = 2 + (i % 8);
      const startingStack = [50, 200, 1000][i % 3];
      const engine = new TexasHoldemGame();
      const { result, state, steps } = playOut(engine, seatRoles(players), 1000 + i, {
        playerCount: players,
        startingStack,
        smallBlind: 5,
        bigBlind: 10
      }, 400);
      expect(result?.isFinished).toBe(true);
      expect(steps).toBeLessThan(400);
      const final = state.find(e => e.type === 'RESULT')!.payload.final_stacks as number[];
      expect(final.reduce((a, b) => a + b, 0)).toBe(players * startingStack);
      expect(Math.min(...final)).toBeGreaterThanOrEqual(0);
    }
  });

  it('asks the correct seat to act after folds (routing matches the engine)', () => {
    const engine = new TexasHoldemGame();
    const state: GameEvent[] = engine.initialize(21, { playerCount: 4, dealerIndex: 0 });
    // UTG is seat4; seat4 folds, seat1 (dealer) folds -> seat2 (SB) is next, never a folded seat
    expect(engine.getActiveRole()).toBe('seat4');
    act(engine, state, 'FOLD');
    expect(engine.getActiveRole()).toBe('seat1');
    act(engine, state, 'FOLD');
    expect(engine.getActiveRole()).toBe('seat2');
  });

  it('rejects a move from the wrong seat', () => {
    const { engine, state } = heads();
    expect(() => engine.processMove(state, { actor: 'seat2', content: 'CALL' })).toThrow(/Out of turn/);
  });
});
