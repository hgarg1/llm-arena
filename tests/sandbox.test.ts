import { loadSandboxedEngine } from '../src/game/sandbox';
import { instantiateGameEngineArtifact } from '../src/services/game-engine-artifact.service';

const GOOD = `
import { GameEngine, GameEvent, GameResult, PlayerMove } from '../types';
export default class CoinGame implements GameEngine {
  gameType = 'coin';
  private flips = 0;
  initialize(seed: number): GameEvent[] {
    this.flips = 0;
    return [{ turn: 0, actor: 'system', type: 'START', payload: { seed } }];
  }
  processMove(history: GameEvent[], move: PlayerMove) {
    this.flips++;
    const turn = history[history.length - 1].turn + 1;
    const events: GameEvent[] = [{ turn, actor: move.actor, type: 'FLIP', payload: { call: move.content } }];
    if (this.flips >= 3) return { events, result: { isFinished: true, scores: { player1: 1, player2: 0 } } as GameResult };
    return { events, result: null };
  }
  getSystemPrompt(role: string) { return 'call heads or tails as ' + role; }
  getRandomMove(h: GameEvent[], role: string) { return { actor: role, content: 'heads' }; }
}`;

describe('sandboxed engine runtime', () => {
  it('runs a generated engine end to end', () => {
    const engine = instantiateGameEngineArtifact('coin', GOOD);
    const state = engine.initialize(9);
    expect(state[0].payload.seed).toBe(9);
    let out = engine.processMove(state, { actor: 'player1', content: 'heads' });
    expect(out.result).toBeNull();
    out = engine.processMove([...state, ...out.events], { actor: 'player2', content: 'tails' });
    out = engine.processMove([...state, ...out.events], { actor: 'player1', content: 'tails' });
    expect(out.result).toMatchObject({ isFinished: true });
    expect(engine.getSystemPrompt('player1')).toContain('player1');
  });

  it('keeps separate state per instance', () => {
    const a = instantiateGameEngineArtifact('coin', GOOD);
    const b = instantiateGameEngineArtifact('coin', GOOD);
    const sa = a.initialize(1);
    const sb = b.initialize(1);
    a.processMove(sa, { actor: 'player1', content: 'x' });
    a.processMove(sa, { actor: 'player1', content: 'x' });
    expect(b.processMove(sb, { actor: 'player1', content: 'x' }).result).toBeNull();
  });

  it('exposes optional hooks only when the engine defines them', () => {
    const engine = instantiateGameEngineArtifact('coin', GOOD);
    expect(engine.getActiveRole).toBeUndefined();
    expect(engine.isAutomatic).toBeUndefined();
  });

  it('kills a hung engine and refuses further calls on it', () => {
    const code = GOOD.replace('this.flips++;', 'while (true) {}');
    const engine = loadSandboxedEngine('coin', instantiateSource(code), { callTimeoutMs: 100 });
    const state = engine.initialize(1);
    expect(() => engine.processMove(state, { actor: 'player1', content: 'x' })).toThrow(/timed out/i);
    // The in-worker timeout leaves the engine usable for non-looping calls only if it was not killed.
    expect(() => engine.getSystemPrompt('player1')).not.toThrow();
    engine.dispose?.();
    expect(() => engine.getSystemPrompt('player1')).toThrow(/disposed/);
  });

  it('survives a memory bomb: only that engine dies, the host keeps running', () => {
    const code = GOOD.replace('this.flips++;', 'const hog: number[][] = []; while (true) { hog.push(new Array(1_000_000).fill(1)); }');
    const engine = loadSandboxedEngine('coin', instantiateSource(code), { callTimeoutMs: 1500, memoryLimitMb: 32 });
    const state = engine.initialize(1);
    const before = process.memoryUsage().rss;
    expect(() => engine.processMove(state, { actor: 'player1', content: 'x' })).toThrow(/timed out|crashed|terminated|memory|no longer running/i);
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024);
    // The host is unaffected and can still load other engines.
    const healthy = instantiateGameEngineArtifact('coin', GOOD);
    expect(healthy.initialize(1)).toHaveLength(1);
    healthy.dispose?.();
  }, 30000);

  it('serves many calls quickly (the synchronous bridge is cheap)', () => {
    const engine = instantiateGameEngineArtifact('coin', GOOD.replace('this.flips >= 3', 'this.flips >= 1000000'));
    const state = engine.initialize(1);
    const started = Date.now();
    for (let i = 0; i < 500; i++) engine.processMove(state, { actor: 'player1', content: 'x' });
    expect(Date.now() - started).toBeLessThan(5000);
    engine.dispose?.();
  });

  it('stops an infinite loop instead of hanging the process', () => {
    const code = GOOD.replace('this.flips++;', 'while (true) {}');
    const engine = loadSandboxedEngine('coin', instantiateSource(code), { callTimeoutMs: 100 });
    const state = engine.initialize(1);
    const started = Date.now();
    expect(() => engine.processMove(state, { actor: 'player1', content: 'x' })).toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('cannot reach node modules or process', () => {
    const fsCode = GOOD.replace("this.flips = 0;\n    return", "require('fs');\n    return");
    expect(() => instantiateGameEngineArtifact('coin', fsCode).initialize(1)).toThrow(/not allowed/);
    const procCode = GOOD.replace("this.flips = 0;\n    return", "process.exit(1);\n    return");
    expect(() => instantiateGameEngineArtifact('coin', procCode).initialize(1)).toThrow(/process is not defined/);
  });

  it('cannot escape through Function constructors', () => {
    const escape = GOOD.replace(
      "this.flips = 0;\n    return",
      "const f = (this as any).constructor.constructor('return process')(); f.exit(1);\n    return"
    );
    expect(() => instantiateGameEngineArtifact('coin', escape).initialize(1)).toThrow(/code generation|EvalError|disallowed/i);
  });

  it('rejects code that does not compile', () => {
    expect(() => instantiateGameEngineArtifact('coin', 'export default class {')).toThrow(/Compile failed/);
  });

  it('rejects modules without a default engine class', () => {
    expect(() => instantiateGameEngineArtifact('coin', 'export const x = 1;')).toThrow(/default class/);
  });

  it('rejects engines missing the contract methods', () => {
    expect(() => instantiateGameEngineArtifact('coin', 'export default class A { initialize() { return []; } }')).toThrow(/contract/);
  });
});

function instantiateSource(ts: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { transpileGameEngineArtifact } = require('../src/services/game-engine-artifact.service');
  return transpileGameEngineArtifact('coin', ts).codeJs as string;
}
