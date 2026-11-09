import { MessageChannel, Worker, receiveMessageOnPort } from 'worker_threads';
import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';

export const DEFAULT_CALL_TIMEOUT_MS = Number(process.env.GAME_ENGINE_CALL_TIMEOUT_MS) || 2000;
export const DEFAULT_MEMORY_LIMIT_MB = Number(process.env.GAME_ENGINE_MEMORY_MB) || 128;
/** Extra time the host waits beyond the in-worker timeout before it kills the worker outright. */
const KILL_GRACE_MS = 500;
const INIT_TIMEOUT_MS = 10_000;

/**
 * Source for the worker thread. It loads the generated code into a `vm` context with no host objects
 * (and no eval/new Function), then serves JSON-in / JSON-out calls over a MessagePort. The host
 * blocks on a shared flag, so the engine facade stays synchronous.
 */
const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const vm = require('vm');
const { port, flag, compiledJs, gameKey, callTimeoutMs } = workerData;
const flagArray = new Int32Array(flag);
let context = null;

const reply = (message) => {
  port.postMessage(message);
  Atomics.store(flagArray, 0, 1);
  Atomics.notify(flagArray, 0);
};

const BOOTSTRAP =
  'var module = { exports: {} }; var exports = module.exports;' +
  'function require(request) {' +
  '  if (request === "../types" || request === "./types" || request === "../../types") return {};' +
  '  throw new Error("require(\\\\"" + request + "\\\\") is not allowed in game engines");' +
  '}';

port.on('message', (message) => {
  try {
    if (message.method === '__init') {
      context = vm.createContext(Object.create(null), { name: 'engine:' + gameKey, codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(BOOTSTRAP, context, { timeout: callTimeoutMs });
      vm.runInContext(
        '(function (module, exports, require) {\\n' + compiledJs + '\\n})(module, exports, require);\\n' +
        'var __Engine = module.exports && module.exports.default ? module.exports.default : module.exports;\\n' +
        'if (typeof __Engine !== "function") throw new Error("Generated engine did not export a default class");\\n' +
        'var __engine = new __Engine();',
        context,
        { timeout: callTimeoutMs, filename: gameKey + '.js' }
      );
      const has = {};
      for (const name of ['initialize', 'processMove', 'getSystemPrompt', 'getRandomMove', 'getActiveRole', 'isAutomatic', 'getObservation']) {
        has[name] = vm.runInContext('typeof __engine.' + name + ' === "function"', context, { timeout: callTimeoutMs }) === true;
      }
      reply({ ok: true, value: JSON.stringify(has) });
      return;
    }
    context.__args = message.args;
    const out = vm.runInContext(
      '(function(){ var r = __engine.' + message.method + '.apply(__engine, JSON.parse(__args)); return r === undefined ? "null" : JSON.stringify(r); })()',
      context,
      { timeout: callTimeoutMs, filename: gameKey + '.' + message.method }
    );
    reply({ ok: true, value: out });
  } catch (error) {
    reply({ ok: false, error: String((error && error.message) || error) });
  }
});
`;

// Safety net: terminate the worker if a facade is garbage collected without dispose().
const FinalizationRegistryCtor = (globalThis as any).FinalizationRegistry as
  | (new (cleanup: (worker: Worker) => void) => { register(target: object, held: Worker): void })
  | undefined;
const registry = FinalizationRegistryCtor ? new FinalizationRegistryCtor(worker => { void worker.terminate(); }) : null;

export interface SandboxOptions {
  callTimeoutMs?: number;
  memoryLimitMb?: number;
}

/**
 * Loads LLM-generated engine code into an isolated worker thread.
 *
 * - Memory: the worker has V8 heap limits, so an allocation bomb kills only that worker.
 * - CPU: calls run under a vm timeout inside the worker, and the host kills the worker if it still
 *   has not answered shortly after, so even a hang that ignores the timeout cannot stall the process.
 * - Isolation: the generated code only ever sees JSON strings; no host object, `require`, `process`,
 *   `eval` or `Function` constructor is reachable.
 *
 * Call `dispose()` when finished. Workers are also unref'd and cleaned up on garbage collection.
 */
export const loadSandboxedEngine = (gameKey: string, compiledJs: string, opts: SandboxOptions = {}): GameEngine => {
  const timeout = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const sharedFlag = new SharedArrayBuffer(4);
  const flag = new Int32Array(sharedFlag);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { port: port2, flag: sharedFlag, compiledJs, gameKey, callTimeoutMs: timeout },
    transferList: [port2],
    resourceLimits: {
      maxOldGenerationSizeMb: opts.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    }
  });
  worker.unref();
  port1.unref();

  let dead = false;
  let deadReason = 'Game engine worker is no longer running';
  worker.on('error', err => { dead = true; deadReason = `Game engine crashed: ${err?.message || err}`; });
  worker.on('exit', () => { dead = true; });

  const kill = (reason: string) => {
    dead = true;
    deadReason = reason;
    void worker.terminate();
    port1.close();
  };

  const rpc = (method: string, args: string, waitMs: number): string => {
    if (dead) throw new Error(deadReason);
    Atomics.store(flag, 0, 0);
    port1.postMessage({ method, args });
    const waited = Atomics.wait(flag, 0, 0, waitMs);
    if (waited === 'timed-out') {
      kill(`Game engine call "${method}" timed out (no response within ${waitMs}ms; engine terminated)`);
      throw new Error(deadReason);
    }
    const received = receiveMessageOnPort(port1);
    if (!received) throw new Error('Game engine returned no response');
    const message = received.message as { ok: boolean; value?: string; error?: string };
    if (!message.ok) {
      // The in-worker vm timeout leaves the engine intact; every other error is just that call failing.
      throw new Error(message.error || 'Game engine call failed');
    }
    return message.value as string;
  };

  const call = <T>(method: string, ...args: unknown[]): T =>
    JSON.parse(rpc(method, JSON.stringify(args), timeout + KILL_GRACE_MS)) as T;

  let has: Record<string, boolean>;
  try {
    has = JSON.parse(rpc('__init', '[]', Math.max(INIT_TIMEOUT_MS, timeout + KILL_GRACE_MS)));
  } catch (err) {
    kill('Game engine failed to load');
    throw err;
  }
  if (!has.initialize || !has.processMove) {
    kill('Game engine does not satisfy the contract');
    throw new Error('Generated engine does not satisfy the GameEngine contract');
  }

  const engine: GameEngine = {
    gameType: gameKey,
    initialize: (seed, options) => call<GameEvent[]>('initialize', seed, options ?? {}),
    processMove: (state, move: PlayerMove) =>
      call<{ events: GameEvent[]; result: GameResult | null }>('processMove', state, move),
    getSystemPrompt: has.getSystemPrompt
      ? role => String(call<string>('getSystemPrompt', role) ?? '')
      : role => `You are playing ${gameKey} as ${role}.`,
    getRandomMove: has.getRandomMove
      ? (state, role) => call<PlayerMove>('getRandomMove', state, role)
      : (_state, role) => ({ actor: role, content: 'PASS' }),
    dispose: () => kill('Game engine was disposed')
  };
  if (has.getActiveRole) engine.getActiveRole = state => call<string | null>('getActiveRole', state);
  if (has.isAutomatic) engine.isAutomatic = (state, role) => Boolean(call<boolean>('isAutomatic', state, role));
  if (has.getObservation) engine.getObservation = (state, role) => call<GameEvent[]>('getObservation', state, role);

  registry?.register(engine, worker);
  return engine;
};
