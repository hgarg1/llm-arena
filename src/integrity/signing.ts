/**
 * Signing a match manifest (docs/INTEGRITY_SPEC.md sections 5 and 6). The private key never touches the repository or
 * the database: it is read from the environment (INTEGRITY_SIGNING_KEY) by default, behind a small `Signer` interface so a
 * key service (KMS, HSM) can replace it without changing the callers.
 */
import { createPublicKey, sign } from 'crypto';
import { SPEC, canonicalize } from './hash-chain';
import { IntegrityConfigError, KeySet, activeKey, keyIdOf, privateKeyFromSeed, publicKeyRawFromSeed } from './keys';

const DOMAIN_MANIFEST = `${SPEC}/manifest\0`;

export interface Signer {
  /** 16 hex characters; must belong to an `active` key in the published key set. */
  keyId: string;
  sign(data: Buffer): Buffer | Promise<Buffer>;
}

export type FinalStatus = 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ManifestInput {
  matchId: string;
  keyId: string;
  gameType: string;
  rulesetVersion: string;
  seed: number;
  status: FinalStatus;
  eventCount: number;
  headHash: string;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null); // always YYYY-MM-DDTHH:mm:ss.sssZ

/** The manifest object of spec section 5 (required members only; reserved members are added by later stories). */
export const buildManifest = (input: ManifestInput) => ({
  spec: SPEC,
  key_id: input.keyId,
  match_id: input.matchId,
  game_type: input.gameType,
  ruleset_version: input.rulesetVersion,
  seed: input.seed,
  status: input.status,
  events: { count: input.eventCount, head_hash: input.headHash },
  started_at: iso(input.startedAt),
  finished_at: iso(input.finishedAt)
});

export type Manifest = ReturnType<typeof buildManifest>;

export interface Envelope {
  manifest: Manifest;
  signature: { alg: 'Ed25519'; key_id: string; sig: string };
}

/** The exact bytes that are signed: DOMAIN_MANIFEST || canonical JSON of the manifest. */
export const manifestBytes = (manifest: Manifest): Buffer => Buffer.concat([Buffer.from(DOMAIN_MANIFEST, 'utf8'), Buffer.from(canonicalize(manifest), 'utf8')]);

export const signManifest = async (manifest: Manifest, signer: Signer): Promise<Envelope> => {
  if (manifest.key_id !== signer.keyId) throw new IntegrityConfigError('manifest key_id does not match the signer');
  const signature = await signer.sign(manifestBytes(manifest));
  return { manifest, signature: { alg: 'Ed25519', key_id: signer.keyId, sig: signature.toString('base64url') } };
};

/** A signer backed by an Ed25519 seed (32 bytes, base64url) held in memory. */
export const signerFromSeed = (seedBase64url: string): Signer => {
  const seed = Buffer.from(seedBase64url.trim(), 'base64url');
  if (seed.length !== 32) throw new IntegrityConfigError('the signing key must be 32 bytes (a base64url Ed25519 seed)');
  const key = privateKeyFromSeed(seed);
  const keyId = keyIdOf(publicKeyRawFromSeed(seed));
  return { keyId, sign: data => sign(null, data, key) };
};

/**
 * Refuses a signer whose key is not the single `active` key of the published set. Signing with an unpublished or retired
 * key would make every match it seals unverifiable, so that is a configuration error, not something to paper over.
 */
export const assertSignerPublished = (signer: Signer, keys: KeySet): void => {
  const active = activeKey(keys);
  if (!active) throw new IntegrityConfigError('no active key is published (src/integrity/published-keys.json)');
  if (active.key_id !== signer.keyId) {
    throw new IntegrityConfigError(`the signing key ${signer.keyId} is not the published active key ${active.key_id}`);
  }
};

/** Sanity check used by tools: the public key matches a signature made by the signer. */
export const publicKeyObject = (publicKeyRaw: Buffer) =>
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyRaw]), format: 'der', type: 'spki' });
