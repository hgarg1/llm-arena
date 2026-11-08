/**
 * Keys, signer and manifest builder (src/integrity), checked against the independent reference implementation and the
 * published test vectors. Ed25519 is deterministic, so production and reference signatures must be byte-identical.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chain } from '../src/integrity/hash-chain';
import { IntegrityConfigError, PUBLISHED_KEYS, activeKey, keyIdOf, parseKeySet, publicKeyRawFromSeed } from '../src/integrity/keys';
import { assertSignerPublished, buildManifest, manifestBytes, signManifest, signerFromSeed } from '../src/integrity/signing';
import * as reference from './helpers/integrity-reference';

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'integrity', 'test-vectors.json'), 'utf8'));
const SEED_A = Buffer.from(vectors.test_keys[0].seed_hex, 'hex');
const SEED_B = Buffer.from(vectors.test_keys[1].seed_hex, 'hex');
const MATCH = '11111111-2222-4333-8444-555555555555';

const entry = (seed: Buffer, status: 'active' | 'retired' | 'revoked' = 'active') => {
  const raw = publicKeyRawFromSeed(seed);
  return { key_id: keyIdOf(raw), alg: 'Ed25519' as const, public_key: raw.toString('base64url'), status };
};
const manifestFor = (keyId: string, overrides: Record<string, unknown> = {}) => buildManifest({
  matchId: MATCH, keyId, gameType: 'chess', rulesetVersion: '1.0.0', seed: 42, status: 'COMPLETED',
  eventCount: 3, headHash: chain(MATCH, vectors.chains[1].events).head, startedAt: new Date('2026-11-08T12:00:00.000Z'), finishedAt: new Date('2026-11-08T12:00:07.250Z'), ...overrides
} as any);

describe('keys', () => {
  it('derive the same public key and key id as the published test vectors', () => {
    for (const k of vectors.test_keys) {
      const raw = publicKeyRawFromSeed(Buffer.from(k.seed_hex, 'hex'));
      expect(raw.toString('base64url')).toBe(k.public_key);
      expect(keyIdOf(raw)).toBe(k.key_id);
    }
  });

  it('the shipped key set is valid', () => {
    expect(() => parseKeySet(PUBLISHED_KEYS)).not.toThrow();
  });

  it('accepts retired and revoked keys next to one active key', () => {
    const set = parseKeySet({ keys: [entry(SEED_A, 'retired'), entry(SEED_B, 'active')] });
    expect(activeKey(set)!.key_id).toBe(entry(SEED_B).key_id);
  });

  it.each<[string, any]>([
    ['not an object', null],
    ['no keys array', {}],
    ['unknown algorithm', { keys: [{ ...entry(SEED_A), alg: 'RSA' }] }],
    ['public key of the wrong size', { keys: [{ ...entry(SEED_A), public_key: 'AAAA' }] }],
    ['unknown status', { keys: [{ ...entry(SEED_A), status: 'maybe' }] }],
    ['key id that does not match the key', { keys: [{ ...entry(SEED_A), key_id: '0000000000000000' }] }],
    ['duplicate key', { keys: [entry(SEED_A), entry(SEED_A)] }],
    ['two active keys', { keys: [entry(SEED_A), entry(SEED_B)] }]
  ])('rejects %s', (_label, input) => {
    expect(() => parseKeySet(input)).toThrow(IntegrityConfigError);
  });
});

describe('signer', () => {
  it('derives its key id from the seed and rejects a malformed seed', () => {
    expect(signerFromSeed(SEED_A.toString('base64url')).keyId).toBe(vectors.test_keys[0].key_id);
    expect(() => signerFromSeed('too-short')).toThrow(IntegrityConfigError);
    expect(() => signerFromSeed(Buffer.alloc(31).toString('base64url'))).toThrow(IntegrityConfigError);
  });

  it('only signs with the single active published key', () => {
    const signer = signerFromSeed(SEED_A.toString('base64url'));
    expect(() => assertSignerPublished(signer, { keys: [entry(SEED_A)] })).not.toThrow();
    expect(() => assertSignerPublished(signer, { keys: [] })).toThrow(/no active key/);
    expect(() => assertSignerPublished(signer, { keys: [entry(SEED_A, 'retired'), entry(SEED_B)] })).toThrow(/not the published active key/);
    expect(() => assertSignerPublished(signer, { keys: [entry(SEED_A, 'revoked')] })).toThrow(IntegrityConfigError);
  });
});

describe('manifest', () => {
  it('contains exactly the required members of the spec, with ISO-8601 millisecond timestamps', () => {
    const m = manifestFor('abcdabcdabcdabcd');
    expect(Object.keys(m).sort()).toEqual(['events', 'finished_at', 'game_type', 'key_id', 'match_id', 'ruleset_version', 'seed', 'spec', 'started_at', 'status']);
    expect(m.spec).toBe('arena-integrity/1');
    expect(m.started_at).toBe('2026-11-08T12:00:00.000Z');
    expect(manifestFor('abcdabcdabcdabcd', { startedAt: null, finishedAt: null })).toMatchObject({ started_at: null, finished_at: null });
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)('a %s match is marked as such, so a partial log is never mistaken for a completed one', status => {
    expect(manifestFor('abcdabcdabcdabcd', { status }).status).toBe(status);
  });

  it('signs the same bytes as the reference, and the signature is byte-identical (Ed25519 is deterministic)', async () => {
    const signer = signerFromSeed(SEED_A.toString('base64url'));
    const manifest = manifestFor(signer.keyId);
    const envelope = await signManifest(manifest, signer);
    const ref = reference.signManifest(manifest, SEED_A);
    expect(envelope.signature).toEqual(ref.signature);
    expect(manifestBytes(manifest).toString('utf8')).toBe('arena-integrity/1/manifest\0' + reference.canonicalize(manifest));
  });

  it('is accepted by the reference verifier, and rejected once anything in it changes', async () => {
    const signer = signerFromSeed(SEED_A.toString('base64url'));
    const events = vectors.chains[1].events;
    const manifest = manifestFor(signer.keyId);
    const envelope = await signManifest(manifest, signer);
    const keys = [entry(SEED_A)];
    expect(reference.verifyMatch(MATCH, events, envelope as any, keys)).toEqual({ result: 'VERIFIED' });
    expect(reference.verifyMatch(MATCH, events, { ...envelope, manifest: { ...manifest, status: 'FAILED' } } as any, keys)).toEqual({ result: 'FAILED', code: 'SIGNATURE_INVALID' });
    expect(reference.verifyMatch(MATCH, events, { ...envelope, manifest: { ...manifest, seed: 43 } } as any, keys)).toEqual({ result: 'FAILED', code: 'SIGNATURE_INVALID' });
  });

  it('refuses to sign a manifest that names a different key than the signer', async () => {
    await expect(signManifest(manifestFor('0000000000000000'), signerFromSeed(SEED_A.toString('base64url')))).rejects.toThrow(IntegrityConfigError);
  });

  it('after rotation, old signatures still verify against the new key set, and the old key can no longer sign', async () => {
    const a = signerFromSeed(SEED_A.toString('base64url'));
    const b = signerFromSeed(SEED_B.toString('base64url'));
    const events = vectors.chains[1].events;
    const before = await signManifest(manifestFor(a.keyId), a);

    const rotated = [entry(SEED_A, 'retired'), entry(SEED_B, 'active')];
    const after = await signManifest(manifestFor(b.keyId), b);
    expect(reference.verifyMatch(MATCH, events, before as any, rotated)).toEqual({ result: 'VERIFIED' });
    expect(reference.verifyMatch(MATCH, events, after as any, rotated)).toEqual({ result: 'VERIFIED' });
    expect(() => assertSignerPublished(a, { keys: rotated })).toThrow(IntegrityConfigError);

    // a compromised key is revoked: everything it signed stops verifying
    const revoked = [entry(SEED_A, 'revoked'), entry(SEED_B, 'active')];
    expect(reference.verifyMatch(MATCH, events, before as any, revoked)).toEqual({ result: 'FAILED', code: 'KEY_REVOKED' });
  });
});

describe('scripts/generate-integrity-key.mjs', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/generate-integrity-key.mjs', ...args], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });

  it('writes the secret only to the file (mode 0600), rotates the key set, and never prints the secret', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-key-'));
    const keysFile = path.join(dir, 'keys.json');
    fs.writeFileSync(keysFile, JSON.stringify({ keys: [entry(SEED_A)] }));
    const secretFile = path.join(dir, 'secret.txt');

    const out = run('--secret-out', secretFile, '--keys-file', keysFile);
    expect(out.status).toBe(0);
    const seed = fs.readFileSync(secretFile, 'utf8').trim();
    expect(out.stdout).not.toContain(seed);
    expect(out.stderr).not.toContain(seed);
    expect((fs.statSync(secretFile).mode & 0o777).toString(8)).toBe('600');

    const set = parseKeySet(JSON.parse(fs.readFileSync(keysFile, 'utf8')));
    const signer = signerFromSeed(seed);
    expect(activeKey(set)!.key_id).toBe(signer.keyId); // the published active key belongs to the generated secret
    expect(set.keys.find(k => k.key_id === entry(SEED_A).key_id)!.status).toBe('retired'); // the previous key stays, retired
    expect(JSON.parse(out.stdout).retired).toEqual([entry(SEED_A).key_id]);
    expect(() => assertSignerPublished(signer, set)).not.toThrow();
  });

  it('will not overwrite an existing secret file, and changes nothing on --dry-run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-key-'));
    const keysFile = path.join(dir, 'keys.json');
    fs.writeFileSync(keysFile, JSON.stringify({ keys: [] }));
    const secretFile = path.join(dir, 'secret.txt');
    fs.writeFileSync(secretFile, 'existing');
    expect(run('--secret-out', secretFile, '--keys-file', keysFile).status).toBe(2);
    expect(fs.readFileSync(secretFile, 'utf8')).toBe('existing');

    const fresh = path.join(dir, 'fresh.txt');
    expect(run('--secret-out', fresh, '--keys-file', keysFile, '--dry-run').status).toBe(0);
    expect(fs.existsSync(fresh)).toBe(false);
    expect(JSON.parse(fs.readFileSync(keysFile, 'utf8'))).toEqual({ keys: [] });
  });
});
