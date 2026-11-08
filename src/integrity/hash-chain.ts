/**
 * Canonical JSON and the event hash chain from docs/INTEGRITY_SPEC.md (arena-integrity/1).
 * Pure and dependency-free apart from Node's crypto, so the runner, the verifier and the CLI can share it.
 * The published vectors in docs/integrity/test-vectors.json are the contract; tests/integrity-chain.test.ts checks them.
 */
import { createHash } from 'crypto';
import { CanonicalizationError, canonicalize } from './canonical';
import { DOMAIN_EVENT, DOMAIN_GENESIS, HEX64, SPEC } from './spec';

export { CanonicalizationError, canonicalize, HEX64, SPEC };

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
