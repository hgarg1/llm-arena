/** Engine identity in the manifest: the built-in hash table, the hashing script, and the new manifest members. */
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { builtInEngineHash, builtInEngineKeys, engineIdentity, sandboxedEngineHash } from '../src/integrity/engine-identity';
import { buildManifest } from '../src/integrity/signing';

const root = path.join(__dirname, '..');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('built-in engine hashes', () => {
  it('cover every built-in game with a 64-character hash', () => {
    expect(builtInEngineKeys().sort()).toEqual(['blackjack', 'chess', 'chutes_and_ladders', 'iterated-negotiation', 'texas_holdem']);
    for (const key of builtInEngineKeys()) expect(builtInEngineHash(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(builtInEngineKeys().map(k => builtInEngineHash(k))).size).toBe(5);
  });

  it('are up to date: an engine (or a library it uses) cannot change without the table being regenerated', () => {
    const run = spawnSync(process.execPath, ['scripts/hash-engines.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
  });

  describe('the script notices what it should', () => {
    // a private copy of the files the script reads, so the real repository is never touched
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-hash-'));
    const copy = (rel: string) => { fs.mkdirSync(path.dirname(path.join(workdir, rel)), { recursive: true }); fs.copyFileSync(path.join(root, rel), path.join(workdir, rel)); };
    const run = () => spawnSync(process.execPath, ['scripts/hash-engines.mjs', '--check'], { cwd: workdir, encoding: 'utf8' }).status;
    const read = (rel: string) => fs.readFileSync(path.join(workdir, rel), 'utf8');
    const write = (rel: string, text: string) => fs.writeFileSync(path.join(workdir, rel), text);

    beforeAll(() => {
      for (const rel of ['scripts/hash-engines.mjs', 'src/integrity/engine-hashes.json', 'src/game/negotiation.ts', 'src/game/types.ts', 'src/game/chess.ts', 'src/game/chutes_ladders.ts', 'src/game/poker.ts', 'src/game/blackjack.ts']) copy(rel);
      for (const lib of ['chess.js', 'pokersolver']) {
        fs.mkdirSync(path.join(workdir, 'node_modules', lib), { recursive: true });
        copyVersion(lib);
      }
    });
    const copyVersion = (lib: string) => fs.copyFileSync(path.join(root, 'node_modules', lib, 'package.json'), path.join(workdir, 'node_modules', lib, 'package.json'));
    afterAll(() => fs.rmSync(workdir, { recursive: true, force: true }));

    it('accepts the repository as it is', () => expect(run()).toBe(0));

    it('a one-character change to an engine changes its hash', () => {
      const original = read('src/game/blackjack.ts');
      write('src/game/blackjack.ts', original + '\n// changed');
      expect(run()).toBe(1);
      write('src/game/blackjack.ts', original);
      expect(run()).toBe(0);
    });

    it('a change to the shared types an engine depends on is noticed too', () => {
      const original = read('src/game/types.ts');
      write('src/game/types.ts', original + '\n// changed');
      expect(run()).toBe(1);
      write('src/game/types.ts', original);
    });

    it('Windows line endings do not change a hash (checkouts agree)', () => {
      const original = read('src/game/chess.ts');
      write('src/game/chess.ts', original.replace(/\r?\n/g, '\r\n'));
      expect(run()).toBe(0);
      write('src/game/chess.ts', original);
    });

    it('upgrading a library an engine uses changes that engine\'s identity', () => {
      const file = path.join(workdir, 'node_modules', 'chess.js', 'package.json');
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), version: '99.0.0' }));
      expect(run()).toBe(1);
      fs.writeFileSync(file, original);
      expect(run()).toBe(0);
    });
  });
});

describe('engineIdentity', () => {
  const artifact = (over: Record<string, unknown> = {}) => ({ id: 'a1', kind: 'SANDBOXED' as const, native_key: null, code_ts: 'export default class X {}', contract_version: 1, ...over });

  it('a built-in game with no pinned artifact is BUILT_IN', () => {
    expect(engineIdentity('chess', null)).toEqual({ kind: 'BUILT_IN', key: 'chess', artifact_id: null, sha256: builtInEngineHash('chess') });
  });

  it('a pinned native artifact is NATIVE and carries the built-in hash of the engine it points to', () => {
    expect(engineIdentity('chess', artifact({ kind: 'NATIVE', native_key: 'chess', code_ts: '' }))).toEqual({ kind: 'NATIVE', key: 'chess', artifact_id: 'a1', sha256: builtInEngineHash('chess') });
    expect(engineIdentity('chess', artifact({ kind: 'NATIVE', native_key: null, code_ts: '' }))!.sha256).toBe(builtInEngineHash('chess')); // falls back to the game key
    expect(engineIdentity('custom', artifact({ kind: 'NATIVE', native_key: 'nope', code_ts: '' }))).toBeNull();
  });

  it('a generated engine is SANDBOXED, identified by the SHA-256 of its source and its contract version', () => {
    const id = engineIdentity('gen-1', artifact({ contract_version: 3 }))!;
    expect(id).toEqual({ kind: 'SANDBOXED', key: 'gen-1', artifact_id: 'a1', sha256: sha256('export default class X {}'), contract_version: 3 });
    expect(sandboxedEngineHash('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'); // SHA-256("a")
    expect(engineIdentity('gen-1', artifact({ code_ts: 'export default class Y {}' }))!.sha256).not.toBe(id.sha256);
  });

  it('an engine that cannot be identified is null, never a guess', () => {
    expect(engineIdentity('not-built-in', null)).toBeNull();
  });
});

describe('manifest members for the engine and settings', () => {
  const base = { matchId: 'm', keyId: 'abcdabcdabcdabcd', gameType: 'chess', rulesetVersion: '1.1.0', seed: 7, status: 'COMPLETED' as const, eventCount: 2, headHash: 'a'.repeat(64), startedAt: null, finishedAt: null };

  it('adds engine, options and options_sha256 only when they are known, and always records the seed', () => {
    expect(Object.keys(buildManifest(base)).sort()).toEqual(['events', 'finished_at', 'game_type', 'key_id', 'match_id', 'ruleset_version', 'seed', 'spec', 'started_at', 'status']);
    const full = buildManifest({ ...base, engine: engineIdentity('chess', null), options: { maxPlies: 40 }, optionsSha256: 'b'.repeat(64) });
    expect(full).toMatchObject({ seed: 7, engine: { kind: 'BUILT_IN', key: 'chess' }, options: { maxPlies: 40 }, options_sha256: 'b'.repeat(64) });
    expect(Object.keys(buildManifest({ ...base, optionsSha256: 'b'.repeat(64) }))).toContain('options_sha256');
    expect(Object.keys(buildManifest({ ...base, optionsSha256: 'b'.repeat(64) }))).not.toContain('options');
  });
});
