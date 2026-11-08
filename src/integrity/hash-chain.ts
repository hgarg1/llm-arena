/**
 * Canonical JSON and the event hash chain from docs/INTEGRITY_SPEC.md (arena-integrity/1).
 * Pure and dependency-free apart from Node's crypto, so the runner, the verifier and the CLI can share it.
 * The published vectors in docs/integrity/test-vectors.json are the contract; tests/integrity-chain.test.ts checks them.
 */
import { createHash } from 'crypto';

export const SPEC = 'arena-integrity/1';
const DOMAIN_GENESIS = `${SPEC}/genesis\n`;
const DOMAIN_EVENT = `${SPEC}/event\0`;
export const HEX64 = /^[0-9a-f]{64}$/;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Canonical JSON (RFC 8785 profile, spec section 3). Throws CanonicalizationError for anything outside the profile. */
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
      if (LONE_SURROGATE.test(value)) throw new CanonicalizationError('lone surrogate');
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

export interface EventRecord {
  seq: number;
  turn_index: number;
  type: string;
  actor_role: string | null;
  payload: unknown;
}

/** The hash a chain starts from. Binding the match id means a log cannot be moved to another match. */
export const genesisHash = (matchId: string): string => sha256(utf8(DOMAIN_GENESIS), utf8(matchId)).toString('hex');

/** The exact object that is canonicalized and hashed for one event (spec section 4.2). */
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
