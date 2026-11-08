import { GameEngine, GameEvent, GameResult } from '../src/game/types';

export interface PlayOutcome {
  state: GameEvent[];
  result: GameResult | null;
  steps: number;
}

/** Plays one game with each engine's own random-move policy, routing turns via getActiveRole. */
export const playOut = (
  engine: GameEngine,
  roles: string[],
  seed: number,
  options: Record<string, any> = {},
  maxSteps = 600
): PlayOutcome => {
  const state: GameEvent[] = [...engine.initialize(seed, options)];
  let result: GameResult | null = null;
  let steps = 0;
  while (!result && steps < maxSteps) {
    let role = engine.getActiveRole ? engine.getActiveRole(state) : null;
    if (!role) role = roles[steps % roles.length];
    const content = role === 'system' ? 'RESOLVE' : engine.getRandomMove(state, role).content;
    const out = engine.processMove(state, { actor: role, content });
    state.push(...out.events);
    result = out.result;
    steps++;
  }
  return { state, result, steps };
};

export const seatRoles = (n: number) => Array.from({ length: n }, (_, i) => `seat${i + 1}`);
