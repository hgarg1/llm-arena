import { validateEngine } from '../src/services/game-validation.service';
import { instantiateGameEngineArtifact } from '../src/services/game-engine-artifact.service';
import { ChessGame } from '../src/game/chess';
import { ChutesLaddersGame } from '../src/game/chutes_ladders';
import { TexasHoldemGame } from '../src/game/poker';
import { BlackjackGame } from '../src/game/blackjack';
import { IteratedNegotiationGame } from '../src/game/negotiation';
import { generateEngineBundle } from '../src/services/engine-generator.service';
import { GameEngine } from '../src/game/types';

const names = (r: ReturnType<typeof validateEngine>) => r.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);

describe('engine validation harness', () => {
  it.each([
    ['chess', () => new ChessGame(), ['white', 'black'], { maxPlies: 40 }],
    ['chutes_and_ladders', () => new ChutesLaddersGame(), ['player1'], {}],
    ['texas_holdem', () => new TexasHoldemGame(), ['seat1', 'seat2', 'seat3'], { playerCount: 3 }],
    ['blackjack', () => new BlackjackGame(), ['seat1', 'seat2'], { playerCount: 2 }],
    ['iterated-negotiation', () => new IteratedNegotiationGame(), ['player1', 'player2'], {}]
  ])('passes for built-in %s', (_name, factory, roles, options) => {
    const report = validateEngine(factory as () => GameEngine, { roles: roles as string[], options: options as any, seed: 42 });
    expect(names(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sampleEvents.length).toBeGreaterThan(1);
  });

  const compile = (body: string) =>
    () => instantiateGameEngineArtifact('t', `export default class T {
      gameType = 't'; n = 0;
      initialize(seed: number) { this.n = 0; return [{ turn: 0, actor: 'system', type: 'S', payload: { seed } }]; }
      getSystemPrompt(role: string) { return 'play ' + role; }
      getRandomMove(h: any, role: string) { return { actor: role, content: 'go' }; }
      ${body}
    }`);

  it('flags an engine that never terminates', () => {
    const report = validateEngine(
      compile(`processMove(h: any, m: any) { return { events: [{ turn: h.length, actor: m.actor, type: 'M', payload: {} }], result: null }; }`),
      { roles: ['player1', 'player2'], maxSteps: 50, seed: 1 }
    );
    expect(report.ok).toBe(false);
    expect(names(report).join()).toMatch(/did not finish/);
  });

  it('flags an engine whose result has no scores', () => {
    const report = validateEngine(
      compile(`processMove(h: any, m: any) { return { events: [{ turn: h.length, actor: m.actor, type: 'M', payload: {} }], result: { isFinished: true, scores: {} } }; }`),
      { roles: ['player1', 'player2'], seed: 1 }
    );
    expect(names(report).join()).toMatch(/scores is empty/);
  });

  it('flags scores keyed by unknown roles', () => {
    const report = validateEngine(
      compile(`processMove(h: any, m: any) { return { events: [{ turn: h.length, actor: m.actor, type: 'M', payload: {} }], result: { isFinished: true, scores: { nobody: 1 } } }; }`),
      { roles: ['player1', 'player2'], seed: 1 }
    );
    expect(names(report).join()).toMatch(/must be game roles/);
  });

  it('flags malformed events and thrown errors', () => {
    expect(names(validateEngine(
      compile(`processMove(h: any, m: any) { return { events: [{ type: 'M' }], result: null }; }`),
      { roles: ['player1'], seed: 1 }
    )).join()).toMatch(/numeric turn/);
    expect(names(validateEngine(
      compile(`processMove(h: any, m: any): any { throw new Error('boom'); }`),
      { roles: ['player1'], seed: 1 }
    )).join()).toMatch(/boom/);
  });

  it('flags non-deterministic setup', () => {
    const report = validateEngine(
      () => instantiateGameEngineArtifact('t', `export default class T {
        initialize() { return [{ turn: 0, actor: 'system', type: 'S', payload: { r: Math.random() } }]; }
        processMove(h: any, m: any) { return { events: [], result: { isFinished: true, scores: { player1: 1 } } }; }
        getSystemPrompt() { return 'x'; } getRandomMove(h: any, r: string) { return { actor: r, content: 'x' }; }
      }`),
      { roles: ['player1'], seed: 1 }
    );
    expect(names(report).join()).toMatch(/different events for the same seed/);
  });

  it('flags engines that hang', () => {
    const report = validateEngine(
      compile(`processMove(h: any, m: any): any { while (true) {} }`),
      { roles: ['player1'], seed: 1 }
    );
    expect(report.ok).toBe(false);
    expect(names(report).join()).toMatch(/timed out/i);
  }, 20000);

  it('the fallback stub engine is not publishable (no scores)', async () => {
    const bundle = await generateEngineBundle(
      { id: 'g', key: 'stub-game', name: 'Stub', description_short: null, description_long: null, status: 'DRAFT', capabilities: [], roles: ['player1', 'player2'], max_players: 2, assets: null, created_at: new Date(), updated_at: new Date(), settings: [], ui_schema: null } as any,
      { forceFallback: true }
    );
    expect(bundle.usedFallback).toBe(true);
    const report = validateEngine(() => instantiateGameEngineArtifact('stub-game', bundle.code), { roles: ['player1', 'player2'], seed: 1 });
    expect(report.ok).toBe(false);
  });
});
