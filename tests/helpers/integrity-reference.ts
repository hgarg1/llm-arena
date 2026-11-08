/**
 * Reference implementation of docs/INTEGRITY_SPEC.md, used only to compute and check the published test vectors.
 * It is deliberately small and self-contained. The production verifier (story m1-05) is a separate module and must
 * reproduce every vector in docs/integrity/test-vectors.json.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'crypto';

export const SPEC = 'arena-integrity/1';
const DOMAIN_GENESIS = `${SPEC}/genesis\n`;
const DOMAIN_EVENT = `${SPEC}/event\0`;
const DOMAIN_MANIFEST = `${SPEC}/manifest\0`;

export class CanonicalizationError extends Error {}

/** Canonical JSON (RFC 8785 profile, see spec section 3). Throws CanonicalizationError for anything outside the profile. */
export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number');
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new CanonicalizationError('integer outside the safe range');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) throw new CanonicalizationError('lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError('not a plain object');
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(); // default sort compares UTF-16 code units, as the profile requires
      for (const key of keys) if (record[key] === undefined) throw new CanonicalizationError(`undefined value at "${key}"`);
      return `{${keys.map(key => `${canonicalize(key)}:${canonicalize(record[key])}`).join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported type ${typeof value}`);
  }
};

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const HEX64 = /^[0-9a-f]{64}$/;

export interface EventRecord {
  seq: number;
  turn_index: number;
  type: string;
  actor_role: string | null;
  payload: unknown;
}

export const genesisHash = (matchId: string): string => sha256(utf8(DOMAIN_GENESIS), utf8(matchId)).toString('hex');

/** The exact object that is canonicalized and hashed for one event. Database ids and created_at are not part of it. */
export const hashedRecord = (matchId: string, event: EventRecord) => ({
  v: 1,
  match_id: matchId,
  seq: event.seq,
  turn_index: event.turn_index,
  type: event.type,
  actor_role: event.actor_role,
  payload: event.payload
});

export const eventHash = (matchId: string, prevHash: string, event: EventRecord): string => {
  if (!HEX64.test(prevHash)) throw new CanonicalizationError('prev_hash must be 64 lowercase hex characters');
  return sha256(utf8(DOMAIN_EVENT), Buffer.from(prevHash, 'hex'), utf8(canonicalize(hashedRecord(matchId, event)))).toString('hex');
};

export const chain = (matchId: string, events: EventRecord[]): { hashes: string[]; head: string } => {
  const hashes: string[] = [];
  let prev = genesisHash(matchId);
  for (const event of events) {
    prev = eventHash(matchId, prev, event);
    hashes.push(prev);
  }
  return { hashes, head: prev };
};

export type FailureCode =
  | 'SPEC_UNSUPPORTED' | 'MALFORMED' | 'MATCH_ID_MISMATCH' | 'EVENT_GAP' | 'EVENT_COUNT_MISMATCH'
  | 'HEAD_MISMATCH' | 'KEY_UNKNOWN' | 'KEY_REVOKED' | 'SIGNATURE_INVALID';

export interface PublicKeyEntry { key_id: string; alg: 'Ed25519'; public_key: string; status: 'active' | 'retired' | 'revoked' }
export interface Envelope {
  manifest: Record<string, any>;
  signature: { alg: 'Ed25519'; key_id: string; sig: string };
}

const b64u = (buf: Buffer) => buf.toString('base64url');
export const keyId = (publicKeyRaw: Buffer) => sha256(publicKeyRaw).subarray(0, 8).toString('hex');

// DER prefixes that wrap a raw 32-byte Ed25519 key for Node's crypto API
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const privateKeyFromSeed = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
export const publicKeyRawFromSeed = (seed: Buffer): Buffer => {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32);
};

export const signManifest = (manifest: Record<string, any>, seed: Buffer): Envelope => {
  const key = privateKeyFromSeed(seed);
  const raw = publicKeyRawFromSeed(seed);
  const data = Buffer.concat([utf8(DOMAIN_MANIFEST), utf8(canonicalize(manifest))]);
  return { manifest, signature: { alg: 'Ed25519', key_id: keyId(raw), sig: b64u(sign(null, data, key)) } };
};

export type Outcome = { result: 'VERIFIED' } | { result: 'FAILED'; code: FailureCode };

/** Verification procedure from spec section 7. Events are the full stored log for the match, in any order. */
export const verifyMatch = (matchId: string, events: EventRecord[], envelope: Envelope, keys: PublicKeyEntry[]): Outcome => {
  const fail = (code: FailureCode): Outcome => ({ result: 'FAILED', code });
  const { manifest, signature } = envelope || ({} as Envelope);
  if (!manifest || typeof manifest !== 'object' || !signature) return fail('MALFORMED');
  if (manifest.spec !== SPEC) return fail('SPEC_UNSUPPORTED');
  if (manifest.match_id !== matchId) return fail('MATCH_ID_MISMATCH');
  let data: Buffer;
  try { data = Buffer.concat([utf8(DOMAIN_MANIFEST), utf8(canonicalize(manifest))]); } catch { return fail('MALFORMED'); }

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < ordered.length; i++) if (ordered[i].seq !== i) return fail('EVENT_GAP');
  if (manifest.events?.count !== ordered.length) return fail('EVENT_COUNT_MISMATCH');
  let computed: { hashes: string[]; head: string };
  try { computed = chain(matchId, ordered); } catch { return fail('MALFORMED'); }
  if (manifest.events?.head_hash !== computed.head) return fail('HEAD_MISMATCH');

  const key = keys.find(k => k.key_id === signature.key_id);
  if (!key) return fail('KEY_UNKNOWN');
  if (key.status === 'revoked') return fail('KEY_REVOKED');
  if (manifest.key_id !== signature.key_id) return fail('SIGNATURE_INVALID');
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key.public_key, 'base64url')]), format: 'der', type: 'spki' });
  const ok = verify(null, data, publicKey, Buffer.from(signature.sig, 'base64url'));
  return ok ? { result: 'VERIFIED' } : fail('SIGNATURE_INVALID');
};
