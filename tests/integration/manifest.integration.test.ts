/**
 * Sealing finished matches on a real Postgres: the signed manifest is created by the real runner and repositories, and
 * every manifest is checked with the independent reference verifier, never with the code that produced it.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
  delete process.env.MATCH_QUEUE_ENABLED;
}

import { MatchStatus, Prisma } from '@prisma/client';
import { prisma } from '../../src/config/db';
import { LeaseLostError, MatchRepository } from '../../src/repositories/match.repository';
import { RunnerRepo, runMatch, runMatchSlice } from '../../src/services/match-runner.service';
import { configureIntegrityForTests, sealIfFinal, sealUnsealed } from '../../src/services/match-manifest.service';
import { signerFromSeed } from '../../src/integrity/signing';
import { getGameEngine } from '../../src/game/registry';
import { scriptedAdapter } from '../helpers/scripted-adapter';
import * as integrity from '../helpers/integrity-reference';
import { createHash } from 'crypto';
import { ensureDefaultGames, ensureNativeArtifacts } from '../../src/services/default-games.service';
import { builtInEngineHash, sandboxedEngineHash } from '../../src/integrity/engine-identity';
import { verifyMatch as verifyWithLibrary, MoveRecord } from '../../src/integrity/verify';
import { nodeProvider } from '../../src/integrity/verify-node';

const maybe = url ? describe : describe.skip;

const GENERATED = `export default class Race {
  n = 0;
  initialize() { this.n = 0; return [{ turn: 0, actor: 'system', type: 'START', payload: {} }]; }
  processMove(h: any, m: any) {
    this.n++;
    const events = [{ turn: h[h.length - 1].turn + 1, actor: m.actor, type: 'STEP', payload: { content: m.content } }];
    return { events, result: this.n >= 3 ? { isFinished: true, scores: { player1: 1, player2: 0 } } : null };
  }
  getSystemPrompt(r: string) { return 'run ' + r; }
  getRandomMove(h: any, r: string) { return { actor: r, content: 'go' }; }
}`;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const uid = () => Math.random().toString(36).slice(2, 10);
const repo = new MatchRepository();

const SEED_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const SEED_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const entry = (seed: Buffer, status: 'active' | 'retired' | 'revoked' = 'active') => {
  const raw = integrity.publicKeyRawFromSeed(seed);
  return { key_id: integrity.keyId(raw), alg: 'Ed25519' as const, public_key: raw.toString('base64url'), status };
};
const signerA = () => signerFromSeed(SEED_A.toString('base64url'));
const signerB = () => signerFromSeed(SEED_B.toString('base64url'));

const createMatch = async (extra: any = {}) => {
  const models = await Promise.all(['white', 'black'].map(() => prisma.model.create({ data: { name: `m-${uid()}`, api_provider: 'openai', api_model_id: 'x' } })));
  return prisma.match.create({
    data: { game_type: 'chess', seed: 7, participants: { create: models.map((m, i) => ({ model_id: m.id, role: ['white', 'black'][i] })) }, ...extra },
    include: { participants: true }
  });
};

const asRunnerRepo = repo as unknown as RunnerRepo;
const mk = (extra: any = {}) => ({ repo: asRunnerRepo, getEngine: getGameEngine, getAdapter: () => scriptedAdapter(), maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra });
const play = async (extra: any = {}, options: any = { maxPlies: 12 }) => {
  const match = await createMatch(extra);
  await runMatch(match.id, options, mk());
  return match.id;
};

const manifestOf = (matchId: string) => prisma.matchManifest.findUnique({ where: { match_id: matchId } });
const verify = async (matchId: string, keys: ReturnType<typeof entry>[]) => {
  const row = await manifestOf(matchId);
  expect(row).not.toBeNull();
  const events = (await prisma.matchEvent.findMany({ where: { match_id: matchId }, orderBy: { seq: 'asc' } }))
    .map(e => ({ seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload }));
  return integrity.verifyMatch(matchId, events, { manifest: row!.manifest as any, signature: { alg: 'Ed25519', key_id: row!.key_id, sig: row!.signature } }, keys);
};

maybe('sealing finished matches (real SQL, real runner)', () => {
  const keysA = [entry(SEED_A)];
  beforeEach(() => configureIntegrityForTests({ signer: signerA(), keys: { keys: keysA } }));
  // the harness database serves one connection: let go of it so the next test file can use it, whatever order they run in
  afterAll(async () => { configureIntegrityForTests(null); await prisma.$disconnect(); });

  describe('a match that ends in each final state is sealed by the runner and verifies independently', () => {
    it('COMPLETED', async () => {
      const id = await play();
      const row = await manifestOf(id);
      expect(row!.manifest).toMatchObject({ spec: integrity.SPEC, match_id: id, game_type: 'chess', seed: 7, status: 'COMPLETED', key_id: keysA[0].key_id });
      expect((row!.manifest as any).events.count).toBe(await prisma.matchEvent.count({ where: { match_id: id } }));
      expect((row!.manifest as any).finished_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(await verify(id, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('FAILED (a model that stays unavailable), with the partial log it left', async () => {
      const match = await createMatch();
      const broken = { generateMove: async () => { throw new Error('provider down'); } };
      await expect(runMatchSlice(match.id, { maxPlies: 12 }, mk({ getAdapter: () => broken, moveAttempts: 1, backoffMs: 0 }))).rejects.toThrow();
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.status).toBe('FAILED');
      expect((await manifestOf(match.id))!.manifest).toMatchObject({ status: 'FAILED' });
      expect(await verify(match.id, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('CANCELLED while pending: an empty log is sealed at the genesis hash', async () => {
      const match = await createMatch();
      await prisma.match.update({ where: { id: match.id }, data: { status: 'CANCELLED', finished_at: new Date() } });
      expect(await sealIfFinal(match.id)).toEqual({ status: 'signed', keyId: keysA[0].key_id });
      const row = await manifestOf(match.id);
      expect(row!.manifest).toMatchObject({ status: 'CANCELLED', events: { count: 0, head_hash: integrity.genesisHash(match.id) } });
      expect(await verify(match.id, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('CANCELLED while running: the runner stops at the next move and seals what it recorded', async () => {
      const match = await createMatch();
      let calls = 0;
      const adapter = () => { const inner = scriptedAdapter(); return { generateMove: async (...a: Parameters<typeof inner.generateMove>) => { if (++calls === 3) await prisma.match.update({ where: { id: match.id }, data: { status: 'CANCELLED', finished_at: new Date() } }); return inner.generateMove(...a); } }; };
      await runMatchSlice(match.id, { maxPlies: 30 }, mk({ getAdapter: adapter }));
      expect((await manifestOf(match.id))!.manifest).toMatchObject({ status: 'CANCELLED' });
      expect(await verify(match.id, keysA)).toEqual({ result: 'VERIFIED' });
    });
  });

  describe('it signs only when it is safe to', () => {
    it('does nothing for a match that is not final', async () => {
      const match = await createMatch({ status: 'RUNNING' });
      expect(await sealIfFinal(match.id)).toMatchObject({ status: 'skipped', code: 'NOT_FINAL' });
      expect(await manifestOf(match.id)).toBeNull();
    });

    it('waits while a runner still holds the lease', async () => {
      const id = await play();
      await prisma.matchManifest.delete({ where: { match_id: id } });
      await prisma.match.update({ where: { id }, data: { lease_owner: 'runner', lease_expires_at: new Date(Date.now() + 60_000) } });
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'LEASE_ACTIVE' });
      await prisma.match.update({ where: { id }, data: { lease_expires_at: new Date(Date.now() - 1000) } }); // the runner died
      expect(await sealIfFinal(id)).toMatchObject({ status: 'signed' });
    });

    it('is idempotent: a second call changes nothing', async () => {
      const id = await play();
      const first = await manifestOf(id);
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'ALREADY_SEALED' });
      expect(await manifestOf(id)).toEqual(first);
    });

    it('never signs a match that began before hash chaining existed', async () => {
      const match = await createMatch({ status: 'COMPLETED', finished_at: new Date() });
      await prisma.matchEvent.createMany({ data: [0, 1].map(seq => ({ match_id: match.id, turn_index: seq, seq, type: 'OLD', actor_role: 'system', payload: {} })) });
      expect(await sealIfFinal(match.id)).toMatchObject({ status: 'skipped', code: 'UNCHAINED' });
      expect(await manifestOf(match.id)).toBeNull();
    });

    it('never signs a log that no longer matches its own hashes', async () => {
      configureIntegrityForTests({ signer: null, keys: { keys: keysA } }); // play without sealing
      const id = await play();
      expect(await manifestOf(id)).toBeNull();
      const target = await prisma.matchEvent.findFirst({ where: { match_id: id, seq: 1 } });
      await prisma.matchEvent.update({ where: { id: target!.id }, data: { payload: { tampered: true } } });

      configureIntegrityForTests({ signer: signerA(), keys: { keys: keysA } });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'CHAIN_BROKEN' });
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('does not verify'));
      errors.mockRestore();
      expect(await manifestOf(id)).toBeNull();
    });

    it('does nothing, and writes nothing, when no signing key is configured', async () => {
      configureIntegrityForTests({ signer: null, keys: { keys: keysA } });
      const id = await play();
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'NO_KEY' });
      expect(await manifestOf(id)).toBeNull();
    });

    it('refuses to sign with a key that is not the published active key (and says so loudly)', async () => {
      configureIntegrityForTests({ signer: signerA(), keys: { keys: [entry(SEED_A, 'retired'), entry(SEED_B)] } });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const id = await play();
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'KEY_NOT_PUBLISHED' });
      expect(errors).toHaveBeenCalled();
      errors.mockRestore();
      expect(await manifestOf(id)).toBeNull();
    });
  });

  describe('a sealed log stays sealed', () => {
    it('refuses further events and moves, and leaves everything exactly as it was', async () => {
      const id = await play();
      const before = await prisma.matchEvent.findMany({ where: { match_id: id }, orderBy: { seq: 'asc' } });
      const moves = await prisma.matchMove.count({ where: { match_id: id } });
      const next = before.length;
      await expect(repo.addEvents(id, [{ turn_index: next, seq: next, type: 'LATE', actor_role: 'system', payload: {} }])).rejects.toBeInstanceOf(LeaseLostError);
      await expect(repo.recordMove(id, { index: moves, actor: 'white', content: 'late' }, [{ turn_index: next, seq: next, type: 'LATE', actor_role: 'white', payload: {} }])).rejects.toBeInstanceOf(LeaseLostError);
      expect(await prisma.matchEvent.findMany({ where: { match_id: id }, orderBy: { seq: 'asc' } })).toEqual(before);
      expect(await prisma.matchMove.count({ where: { match_id: id } })).toBe(moves);
      expect(await verify(id, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('retrying the match deletes the manifest, play continues the same chain, and the next final state is signed afresh', async () => {
      const id = await play({}, { maxPlies: 6 });
      const first = await manifestOf(id);
      expect((first!.manifest as any).status).toBe('COMPLETED');

      await repo.updateStatus(id, MatchStatus.RUNNING, undefined, null); // what a retry or resume does first
      expect(await manifestOf(id)).toBeNull();

      const count = await prisma.matchEvent.count({ where: { match_id: id } });
      await repo.addEvents(id, [{ turn_index: count, seq: count, type: 'EXTRA', actor_role: 'system', payload: { more: true } }]);
      await prisma.match.update({ where: { id }, data: { status: 'COMPLETED', finished_at: new Date() } });
      expect(await sealIfFinal(id)).toMatchObject({ status: 'signed' });

      const second = await manifestOf(id);
      expect((second!.manifest as any).events.count).toBe(count + 1);
      expect((second!.manifest as any).events.head_hash).not.toBe((first!.manifest as any).events.head_hash);
      expect(await verify(id, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('is deleted with its match', async () => {
      const match = await createMatch({ status: 'CANCELLED', finished_at: new Date() });
      await sealIfFinal(match.id);
      expect(await manifestOf(match.id)).not.toBeNull();
      await prisma.matchParticipant.deleteMany({ where: { match_id: match.id } });
      await prisma.match.delete({ where: { id: match.id } });
      expect(await manifestOf(match.id)).toBeNull();
    });
  });

  describe('key rotation', () => {
    it('keeps old signatures verifiable, signs new matches with the new key, and retires the old one for signing', async () => {
      const before = await play();
      expect((await manifestOf(before))!.key_id).toBe(entry(SEED_A).key_id);

      const rotated = [entry(SEED_A, 'retired'), entry(SEED_B)];
      configureIntegrityForTests({ signer: signerB(), keys: { keys: rotated } });
      const after = await play();
      expect((await manifestOf(after))!.key_id).toBe(entry(SEED_B).key_id);
      expect(await verify(before, rotated)).toEqual({ result: 'VERIFIED' });
      expect(await verify(after, rotated)).toEqual({ result: 'VERIFIED' });

      configureIntegrityForTests({ signer: signerA(), keys: { keys: rotated } }); // the old key can no longer seal anything
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const late = await play();
      errors.mockRestore();
      expect(await manifestOf(late)).toBeNull();

      const compromised = [entry(SEED_A, 'revoked'), entry(SEED_B)];
      expect(await verify(before, compromised)).toEqual({ result: 'FAILED', code: 'KEY_REVOKED' });
      expect(await verify(after, compromised)).toEqual({ result: 'VERIFIED' });
    });
  });

  describe('the repair pass', () => {
    it('seals recent finished matches that were missed, and leaves legacy, old and unfinished ones alone', async () => {
      configureIntegrityForTests({ signer: null, keys: { keys: keysA } });
      const missed = await play();                                   // finished, chained, unsealed
      const cancelled = (await createMatch({ status: 'CANCELLED', finished_at: new Date() })).id; // finished with no events
      const legacy = await createMatch({ status: 'COMPLETED', finished_at: new Date() });
      await prisma.matchEvent.create({ data: { match_id: legacy.id, turn_index: 0, seq: 0, type: 'OLD', actor_role: 'system', payload: {} } });
      const old = await play();
      await prisma.match.update({ where: { id: old }, data: { created_at: new Date(Date.now() - 20 * 86_400_000) } });
      const running = (await createMatch({ status: 'RUNNING' })).id;

      configureIntegrityForTests({ signer: signerA(), keys: { keys: keysA } });
      const result = await sealUnsealed({ limit: 1000, lookbackHours: 72 });
      expect(result.counts.signed).toBeGreaterThanOrEqual(2);
      expect(await manifestOf(missed)).not.toBeNull();
      expect(await manifestOf(cancelled)).not.toBeNull();
      expect(await manifestOf(legacy.id)).toBeNull();
      expect(await manifestOf(old)).toBeNull();
      expect(await manifestOf(running)).toBeNull();
      expect(await verify(missed, keysA)).toEqual({ result: 'VERIFIED' });
      expect(await verify(cancelled, keysA)).toEqual({ result: 'VERIFIED' });
    });

    it('does no database work at all when signing is off', async () => {
      configureIntegrityForTests({ signer: null });
      const spy = jest.spyOn(prisma.match, 'findMany');
      expect(await sealUnsealed()).toEqual({ scanned: 0, counts: {} });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
  describe('what the manifest says about the engine and the settings', () => {
    const manifestMembers = async (id: string) => (await manifestOf(id))!.manifest as any;
    /** Both verifiers (the independent reference and the production library) accept the sealed match. */
    const bothVerify = async (id: string) => {
      expect(await verify(id, keysA)).toEqual({ result: 'VERIFIED' });
      const row = (await manifestOf(id))!;
      const events = (await prisma.matchEvent.findMany({ where: { match_id: id }, orderBy: { seq: 'asc' } })).map(e => ({ seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload }));
      const moves = (await prisma.matchMove.findMany({ where: { match_id: id }, orderBy: { move_index: 'asc' } })).map(m => ({ move_index: m.move_index, actor_role: m.actor_role, content: m.content, provenance: m.provenance }));
      expect(await verifyWithLibrary(nodeProvider, id, events, { manifest: row.manifest as any, signature: { alg: 'Ed25519', key_id: row.key_id, sig: row.signature } }, keysA, { moves })).toEqual({ result: 'VERIFIED' });
    };

    it('a built-in game records its engine hash, the resolved settings, their hash and the seed', async () => {
      const options = { maxPlies: 12, allowDraws: false };
      const id = await play({ options, seed: 31 }, options);
      const m = await manifestMembers(id);
      expect(m.seed).toBe(31);
      expect(m.engine).toEqual({ kind: 'BUILT_IN', key: 'chess', artifact_id: null, sha256: builtInEngineHash('chess') });
      expect(m.options).toEqual(options);
      expect(m.options_sha256).toBe(sha256(integrity.canonicalize(options)));
      await bothVerify(id);
    });

    it('a match pinned to a native artifact is NATIVE and names the engine it points to', async () => {
      await ensureDefaultGames();
      await ensureNativeArtifacts();
      const artifact = await prisma.gameEngineArtifact.findFirst({ where: { kind: 'NATIVE', game: { key: 'chess' } } });
      const id = await play({ engine_artifact_id: artifact!.id });
      expect((await manifestMembers(id)).engine).toEqual({ kind: 'NATIVE', key: 'chess', artifact_id: artifact!.id, sha256: builtInEngineHash('chess') });
      await bothVerify(id);
    });

    it('a generated game records the hash of the code that ran, and a later edit of that code is detectable', async () => {
      const key = `gen-${uid()}`;
      const game = await prisma.gameDefinition.create({ data: { key, name: key, roles: ['player1', 'player2'], capabilities: [], status: 'LIVE' } });
      const artifact = await prisma.gameEngineArtifact.create({ data: { game_id: game.id, status: 'PUBLISHED', spec: {}, code_ts: GENERATED } });
      const match = await prisma.match.create({ data: { game_type: key, seed: 5, engine_artifact_id: artifact.id, participants: { create: await Promise.all(['player1', 'player2'].map(async role => ({ role, model_id: (await prisma.model.create({ data: { name: `m-${uid()}`, api_provider: 'openai', api_model_id: 'x' } })).id }))) } } });
      await runMatch(match.id, {}, mk());

      const m = await manifestMembers(match.id);
      expect(m.engine).toEqual({ kind: 'SANDBOXED', key, artifact_id: artifact.id, sha256: sha256(GENERATED), contract_version: artifact.contract_version });
      await bothVerify(match.id);

      // someone later swaps the artifact's code: the manifest still commits to the original, so the mismatch shows
      await prisma.gameEngineArtifact.update({ where: { id: artifact.id }, data: { code_ts: GENERATED + '\n// edited after the match' } });
      const current = (await prisma.gameEngineArtifact.findUnique({ where: { id: artifact.id } }))!;
      expect(sandboxedEngineHash(current.code_ts)).not.toBe(m.engine.sha256);
      await bothVerify(match.id); // and the signature on what was recorded is untouched
    });

    it('settings too large to embed are represented by their hash alone', async () => {
      const options = { notes: 'x'.repeat(20_000) };
      const match = await createMatch({ status: 'CANCELLED', finished_at: new Date(), options });
      await sealIfFinal(match.id);
      const m = await manifestMembers(match.id);
      expect(m.options).toBeUndefined();
      expect(m.options_sha256).toBe(sha256(integrity.canonicalize(options)));
      await bothVerify(match.id);
    });

    it('a match with no settings records the hash of the empty object', async () => {
      const match = await createMatch({ status: 'CANCELLED', finished_at: new Date() });
      await sealIfFinal(match.id);
      const m = await manifestMembers(match.id);
      expect(m.options).toEqual({});
      expect(m.options_sha256).toBe(sha256('{}'));
    });

    it('an engine that cannot be identified is left out, with a warning, and the match is still sealed', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const match = await createMatch({ game_type: `unknown-${uid()}`, status: 'CANCELLED', finished_at: new Date() });
      expect(await sealIfFinal(match.id)).toMatchObject({ status: 'signed' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('engine identity'));
      warn.mockRestore();
      expect((await manifestMembers(match.id)).engine).toBeUndefined();
      await bothVerify(match.id);
    });
  });
  describe('moves and their provenance in the manifest', () => {
    const REPORT = { adapter: 'anthropic', model_reported: 'model-x-20260101', sampling: { temperature: 0, max_tokens: 1024, top_p: 'provider-default' } };
    const reportingAdapter = () => { const inner = scriptedAdapter(); return { generateMove: inner.generateMove, generateMoveWithMeta: async (...a: Parameters<typeof inner.generateMove>) => ({ text: await inner.generateMove(...a), meta: REPORT }) }; };
    const movesOf = async (id: string): Promise<MoveRecord[]> =>
      (await prisma.matchMove.findMany({ where: { match_id: id }, orderBy: { move_index: 'asc' } })).map(m => ({ move_index: m.move_index, actor_role: m.actor_role, content: m.content, provenance: m.provenance }));
    const eventsOf = async (id: string) => (await prisma.matchEvent.findMany({ where: { match_id: id }, orderBy: { seq: 'asc' } })).map(e => ({ seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload }));
    const check = async (id: string, moves?: MoveRecord[]) => {
      const row = (await manifestOf(id))!;
      return verifyWithLibrary(nodeProvider, id, await eventsOf(id), { manifest: row.manifest as any, signature: { alg: 'Ed25519', key_id: row.key_id, sig: row.signature } }, keysA, moves ? { moves } : {});
    };
    const playReporting = async () => {
      const match = await createMatch({ options: { maxPlies: 8 } });
      await runMatch(match.id, { maxPlies: 8 }, mk({ getAdapter: () => reportingAdapter() }));
      return match.id;
    };

    it('the runner stores provenance with every move, and the manifest commits to all of it', async () => {
      const id = await playReporting();
      const moves = await movesOf(id);
      expect(moves.length).toBeGreaterThanOrEqual(8);
      expect(moves.every(m => m.provenance && (m.provenance as any).v === 1)).toBe(true);
      expect((moves[0].provenance as any).model).toEqual({ provider: 'openai', requested: 'x', reported: 'model-x-20260101' });
      expect((moves[0].provenance as any).prompt).toMatchObject({ id: 'chess/white', version: '1.1.0' });

      const committed = ((await manifestOf(id))!.manifest as any).provenance;
      expect(committed).toEqual({ v: 1, moves: { count: moves.length, head_hash: integrity.moveChain(id, moves).head } });
      expect(await check(id, moves)).toEqual({ result: 'VERIFIED' });
      expect(integrity.verifyMatch(id, await eventsOf(id), { manifest: (await manifestOf(id))!.manifest as any, signature: { alg: 'Ed25519', key_id: (await manifestOf(id))!.key_id, sig: (await manifestOf(id))!.signature } }, keysA, moves)).toEqual({ result: 'VERIFIED' });
    });

    it('without the moves the library says they were not checked, instead of passing silently', async () => {
      const id = await playReporting();
      expect(await check(id)).toEqual({ result: 'VERIFIED', unchecked: ['moves'] });
    });

    it('editing a stored move\'s provenance afterwards is detected, and the events and signature are untouched', async () => {
      const id = await playReporting();
      const target = await prisma.matchMove.findFirst({ where: { match_id: id, move_index: 2 } });
      await prisma.matchMove.update({ where: { id: target!.id }, data: { provenance: { ...(target!.provenance as any), sampling: { temperature: 0.9, max_tokens: 1024, top_p: 'provider-default' } } } });
      expect(await check(id, await movesOf(id))).toMatchObject({ result: 'FAILED', code: 'MOVES_MISMATCH', detail: { reason: 'head' } });
      expect(await verify(id, keysA)).toEqual({ result: 'VERIFIED' }); // the event chain and the signature itself are still fine
    });

    it('editing a stored move\'s text, or deleting a move, is detected', async () => {
      const id = await playReporting();
      const all = await prisma.matchMove.findMany({ where: { match_id: id }, orderBy: { move_index: 'asc' } });
      await prisma.matchMove.update({ where: { id: all[1].id }, data: { content: 'a1a2' } });
      expect(await check(id, await movesOf(id))).toMatchObject({ code: 'MOVES_MISMATCH', detail: { reason: 'head' } });
      await prisma.matchMove.delete({ where: { id: all[all.length - 1].id } });
      expect(await check(id, await movesOf(id))).toMatchObject({ code: 'MOVES_MISMATCH', detail: { reason: 'count' } });
    });

    it('moves recorded before provenance existed (NULL) are committed to as "not recorded", and still verify', async () => {
      configureIntegrityForTests({ signer: null, keys: { keys: keysA } });
      const id = await playReporting();
      await prisma.matchMove.updateMany({ where: { match_id: id }, data: { provenance: Prisma.DbNull } });
      configureIntegrityForTests({ signer: signerA(), keys: { keys: keysA } });
      expect(await sealIfFinal(id)).toMatchObject({ status: 'signed' });
      const moves = await movesOf(id);
      expect(moves.every(m => m.provenance === null)).toBe(true);
      expect(await check(id, moves)).toEqual({ result: 'VERIFIED' });
    });

    it('a match with no moves has no moves digest', async () => {
      const match = await createMatch({ status: 'CANCELLED', finished_at: new Date() });
      await sealIfFinal(match.id);
      expect(((await manifestOf(match.id))!.manifest as any).provenance).toBeUndefined();
      expect(await check(match.id)).toEqual({ result: 'VERIFIED' });
    });

    it('refuses to sign moves that are not numbered 0..n-1', async () => {
      configureIntegrityForTests({ signer: null, keys: { keys: keysA } });
      const id = await playReporting();
      const second = await prisma.matchMove.findFirst({ where: { match_id: id, move_index: 1 } });
      await prisma.matchMove.delete({ where: { id: second!.id } });
      configureIntegrityForTests({ signer: signerA(), keys: { keys: keysA } });
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await sealIfFinal(id)).toMatchObject({ status: 'skipped', code: 'MOVES_BROKEN' });
      errors.mockRestore();
      expect(await manifestOf(id)).toBeNull();
    });

    it('a retried match is sealed again with a digest over all of its moves', async () => {
      const id = await playReporting();
      const first = ((await manifestOf(id))!.manifest as any).provenance.moves;
      await repo.updateStatus(id, MatchStatus.RUNNING, undefined, null);
      const count = first.count;
      await repo.recordMove(id, { index: count, actor: 'white', content: 'extra', provenance: { v: 1, source: 'engine', prompt: null, model: null, sampling: null, adapter: null } }, [{ turn_index: 99, seq: await repo.countEvents(id), type: 'EXTRA', actor_role: 'white', payload: {} }]);
      await prisma.match.update({ where: { id }, data: { status: 'COMPLETED', finished_at: new Date() } });
      expect(await sealIfFinal(id)).toMatchObject({ status: 'signed' });
      const second = ((await manifestOf(id))!.manifest as any).provenance.moves;
      expect(second.count).toBe(count + 1);
      expect(second.head_hash).not.toBe(first.head_hash);
      expect(await check(id, await movesOf(id))).toEqual({ result: 'VERIFIED' });
    });
  });
});
