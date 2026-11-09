/**
 * Appending events to a match log while keeping its hash chain (docs/INTEGRITY_SPEC.md section 4.4).
 * Repositories call chainAppend with the stored tail of the log, inside the same transaction that writes the rows,
 * so the chain is always extended from what is really stored.
 */
import { EventRecord, eventHash, genesisHash } from './hash-chain';

/** The stored log is not what the caller believes it is (a gap, a repeat, or an event that cannot be hashed). */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface ChainTail {
  seq: number;
  /** null when the stored events predate hash chaining: that match stays unchained for good (it is "Unverified"). */
  hash: string | null;
}

export interface EventInput {
  turn_index: number;
  seq: number;
  type: string;
  actor_role: string | null;
  payload: unknown;
}

/** What storage will hold for the payload: JSON round trip, so the hash covers exactly what is read back later. */
export const storedPayload = (payload: unknown): unknown => JSON.parse(JSON.stringify(payload === undefined ? {} : payload));

/**
 * Returns the rows to store, with `payload` normalised and `hash` / `prev_hash` filled in.
 * - `tail` is the stored event with the highest seq, or null when the match has no events yet (chain starts at genesis).
 * - A tail without a hash means the match started before chaining existed: rows are returned unchained.
 * - Rows are ordered by seq first (seq defines the order of a log, not the order a caller listed them in).
 * - Otherwise the first new seq must be tail.seq + 1 (0 for an empty log) and seqs must be consecutive.
 */
export const chainAppend = <T extends EventInput>(
  matchId: string,
  tail: ChainTail | null,
  rows: T[]
): Array<T & { hash: string | null; prev_hash: string | null }> => {
  if (rows.length === 0) return [];
  const normalised = rows.map(row => ({ ...row, payload: storedPayload(row.payload) })).sort((a, b) => a.seq - b.seq);
  if (tail && tail.hash === null) return normalised.map(row => ({ ...row, hash: null, prev_hash: null }));

  let expected = tail ? tail.seq + 1 : 0;
  let prev = tail && tail.hash ? tail.hash : genesisHash(matchId);
  return normalised.map(row => {
    if (row.seq !== expected) {
      throw new IntegrityError(`match ${matchId}: expected event seq ${expected} but got ${row.seq}; the stored log and the engine replay disagree`);
    }
    let hash: string;
    try {
      hash = eventHash(matchId, prev, row as EventRecord);
    } catch (err) {
      throw new IntegrityError(`match ${matchId}: event seq ${row.seq} (${row.type}) cannot be hashed: ${(err as Error).message}`);
    }
    const out = { ...row, hash, prev_hash: prev };
    prev = hash;
    expected++;
    return out;
  });
};
