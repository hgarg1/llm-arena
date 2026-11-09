import { GameEngine, GameEvent } from '../game/types';

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
  sampleEvents: GameEvent[];
  seed: number;
}

export interface ValidationSpec {
  roles: string[];
  options?: Record<string, any>;
  games?: number;
  maxSteps?: number;
  seed?: number;
}

const isEvent = (e: any): e is GameEvent =>
  e && typeof e === 'object' && typeof e.actor === 'string' && typeof e.type === 'string' &&
  typeof e.turn === 'number' && Number.isFinite(e.turn) && e.payload && typeof e.payload === 'object';

const badEvent = (events: any): string | null => {
  if (!Array.isArray(events)) return 'events is not an array';
  const idx = events.findIndex(e => !isEvent(e));
  return idx === -1 ? null : `event #${idx} must have numeric turn, string actor/type and an object payload`;
};

/**
 * Plays complete seeded games with the engine's own `getRandomMove` and checks the engine honours the
 * contract: valid events, deterministic setup, termination, and a score for the players.
 * `factory` must return a fresh engine instance each call.
 */
export const validateEngine = (rawFactory: () => GameEngine, spec: ValidationSpec): ValidationReport => {
  // Sandboxed engines own a worker thread each; make sure every instance is released.
  const instances: GameEngine[] = [];
  const factory = () => {
    const engine = rawFactory();
    instances.push(engine);
    return engine;
  };
  try {
    return runValidation(factory, spec);
  } finally {
    instances.forEach(engine => engine.dispose?.());
  }
};

const runValidation = (factory: () => GameEngine, spec: ValidationSpec): ValidationReport => {
  const roles = spec.roles.length > 0 ? spec.roles : ['player1', 'player2'];
  const games = spec.games ?? 5;
  const maxSteps = spec.maxSteps ?? 500;
  const baseSeed = spec.seed ?? Math.floor(Math.random() * 1_000_000);
  const checks: ValidationCheck[] = [];
  let sampleEvents: GameEvent[] = [];

  // A hung or crashed engine fails fast: later checks would only repeat the same stall.
  let engineStalled = false;
  const record = (name: string, fn: () => string | null | void) => {
    if (engineStalled) {
      checks.push({ name, ok: false, detail: 'Skipped: the engine stopped responding in an earlier check' });
      return;
    }
    try {
      const problem = fn();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (err: any) {
      const detail = String(err?.message || err);
      if (/timed out|terminated|crashed|no longer running/i.test(detail)) engineStalled = true;
      checks.push({ name, ok: false, detail });
    }
  };

  record('Initializes with valid events', () => {
    const events = factory().initialize(baseSeed, spec.options ?? {});
    if (!events || events.length === 0) return 'initialize() returned no events';
    return badEvent(events);
  });

  record('Setup is deterministic for a seed', () => {
    const a = JSON.stringify(factory().initialize(baseSeed, spec.options ?? {}));
    const b = JSON.stringify(factory().initialize(baseSeed, spec.options ?? {}));
    return a === b ? null : 'initialize() produced different events for the same seed';
  });

  record('Provides a system prompt for every role', () => {
    const engine = factory();
    engine.initialize(baseSeed, spec.options ?? {});
    const missing = roles.filter(role => !String(engine.getSystemPrompt(role) || '').trim());
    return missing.length ? `Empty prompt for: ${missing.join(', ')}` : null;
  });

  const finished: string[] = [];
  let recorded: { seed: number; moves: Array<{ actor: string; content: string }>; events: string } | null = null;
  record(`Plays ${games} seeded games to completion`, () => {
    for (let g = 0; g < games; g++) {
      const seed = baseSeed + g;
      const engine = factory();
      const state: GameEvent[] = [...(engine.initialize(seed, spec.options ?? {}) || [])];
      const played: Array<{ actor: string; content: string }> = [];
      let done = false;
      for (let step = 0; step < maxSteps && !done; step++) {
        let role = engine.getActiveRole ? engine.getActiveRole(state) : null;
        if (!role) role = roles[step % roles.length];
        const move = role === 'system'
          ? { actor: 'system', content: 'RESOLVE' }
          : engine.getRandomMove(state, role);
        if (!move || typeof move.content !== 'string') return `Game ${g + 1}: getRandomMove did not return a move with text content`;
        played.push({ actor: role, content: move.content });
        const out = engine.processMove(state, { actor: role, content: move.content });
        const problem = badEvent(out?.events);
        if (problem) return `Game ${g + 1}, step ${step}: ${problem}`;
        out.events.forEach(e => state.push(e));
        if (out.result) {
          if (!out.result.isFinished) return `Game ${g + 1}: result returned with isFinished=false`;
          const scoreKeys = Object.keys(out.result.scores || {});
          if (scoreKeys.length === 0) return `Game ${g + 1}: result.scores is empty; report a score per role`;
          if (scoreKeys.some(k => !Number.isFinite(out.result!.scores[k]))) return `Game ${g + 1}: result.scores has non-numeric values`;
          if (roles.length > 0 && scoreKeys.some(k => !roles.includes(k))) {
            return `Game ${g + 1}: result.scores keys (${scoreKeys.join(', ')}) must be game roles (${roles.join(', ')})`;
          }
          done = true;
          finished.push(`${state.length} events`);
          if (g === 0) {
            sampleEvents = state.slice(0, 200);
            recorded = { seed, moves: played, events: JSON.stringify(state) };
          }
        }
      }
      if (!done) return `Game ${g + 1} did not finish within ${maxSteps} moves`;
    }
    return null;
  });

  // Matches continue in new processes by replaying recorded moves, so replay must reproduce the game exactly.
  record('Replaying the recorded moves reproduces the same game', () => {
    if (!recorded) return 'No finished game to replay';
    const engine = factory();
    const state: GameEvent[] = [...(engine.initialize(recorded.seed, spec.options ?? {}) || [])];
    for (const move of recorded.moves) {
      state.push(...engine.processMove(state, { actor: move.actor, content: move.content }).events);
    }
    return JSON.stringify(state) === recorded.events ? null : 'Replaying the same seed and moves produced different events; engines must be deterministic';
  });

  record('Turns are non-decreasing', () => {
    for (let i = 1; i < sampleEvents.length; i++) {
      if (sampleEvents[i].turn < sampleEvents[i - 1].turn) return `Turn index went backwards at event #${i}`;
    }
    return null;
  });

  return { ok: checks.every(c => c.ok), checks, sampleEvents, seed: baseSeed };
};
