/**
 * The published key set (docs/INTEGRITY_SPEC.md section 6.3). Public keys are not secret: they live in the repository
 * (src/integrity/published-keys.json), are served to verifiers, and are never removed, so old signatures stay verifiable.
 * Rotation adds a new `active` key and marks the previous one `retired`; a compromised key becomes `revoked`.
 */
import { createHash, createPrivateKey, createPublicKey } from 'crypto';
import published from './published-keys.json';

export type KeyStatus = 'active' | 'retired' | 'revoked';
export interface PublishedKey {
  key_id: string;
  alg: 'Ed25519';
  /** base64url of the raw 32-byte public key */
  public_key: string;
  status: KeyStatus;
}
export interface KeySet {
  keys: PublishedKey[];
}

export class IntegrityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityConfigError';
  }
}

/** First 8 bytes of SHA-256(raw public key), 16 lowercase hex characters (spec section 6.1). */
export const keyIdOf = (publicKeyRaw: Buffer): string => createHash('sha256').update(publicKeyRaw).digest().subarray(0, 8).toString('hex');

// DER prefixes that wrap a raw 32-byte Ed25519 key for Node's crypto API
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const privateKeyFromSeed = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
export const publicKeyRawFromSeed = (seed: Buffer): Buffer => {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32);
};

const B64URL32 = /^[A-Za-z0-9_-]{43}$/;

/** Validates a key set document. Throws IntegrityConfigError describing the first problem. */
export const parseKeySet = (input: unknown): KeySet => {
  const keys = (input as KeySet | undefined)?.keys;
  if (!Array.isArray(keys)) throw new IntegrityConfigError('key set must be an object with a "keys" array');
  const seen = new Set<string>();
  let active = 0;
  for (const key of keys) {
    if (!key || typeof key !== 'object') throw new IntegrityConfigError('key set entries must be objects');
    if (key.alg !== 'Ed25519') throw new IntegrityConfigError(`key ${key.key_id}: unsupported algorithm ${key.alg}`);
    if (!B64URL32.test(String(key.public_key))) throw new IntegrityConfigError(`key ${key.key_id}: public_key must be 32 bytes, base64url without padding`);
    if (!['active', 'retired', 'revoked'].includes(key.status)) throw new IntegrityConfigError(`key ${key.key_id}: unknown status ${key.status}`);
    if (keyIdOf(Buffer.from(key.public_key, 'base64url')) !== key.key_id) throw new IntegrityConfigError(`key ${key.key_id} does not match its public key`);
    if (seen.has(key.key_id)) throw new IntegrityConfigError(`duplicate key ${key.key_id}`);
    seen.add(key.key_id);
    if (key.status === 'active') active++;
  }
  if (active > 1) throw new IntegrityConfigError('at most one key may be active');
  return { keys };
};

export const PUBLISHED_KEYS: KeySet = parseKeySet(published);

export const activeKey = (set: KeySet): PublishedKey | null => set.keys.find(k => k.status === 'active') ?? null;
