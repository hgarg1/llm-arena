/**
 * Match verification (docs/INTEGRITY_SPEC.md section 7). Pure TypeScript: it imports nothing but other pure integrity
 * modules, touches no database, and uses no Node or browser global except TextEncoder. The two cryptographic primitives
 * are injected (a `CryptoProvider`): `nodeProvider` in verify-node.ts, `webProvider` in verify-web.ts. The same checks
 * therefore run in Node (the CLI, the runner's tests) and in a web page (the "Verify this match" page).
 *
 * Outcomes:
 *  - VERIFIED    every check passed.
 *  - UNVERIFIED  there is no manifest: the match predates signing, or was never sealed. It is not a failure.
 *  - FAILED      a check failed; `code` says which (the spec's table, in order).
 *  - ERROR       the environment could not run a check (for example no Ed25519 support). Never read as pass or fail.
 */
import { CanonicalizationError, canonicalize } from './canonical';
import { DOMAIN_EVENT, DOMAIN_GENESIS, DOMAIN_MANIFEST, DOMAIN_MOVE, DOMAIN_MOVES_GENESIS, HEX64, SPEC } from './spec';

export interface CryptoProvider {
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Verifies an Ed25519 signature. Resolves false for a bad signature; rejects only if Ed25519 cannot be used at all. */
  ed25519Verify(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

export interface EventRecord {
  seq: number;
  turn_index: number;
  type: string;
  actor_role: string | null;
  payload: unknown;
  /** Optional, untrusted: when present it only helps point at the first event that differs (`detail.firstMismatchSeq`). */
  hash?: string | null;
}

export interface Envelope {
  manifest: Record<string, any>;
  signature: { alg?: string; key_id: string; sig: string };
}

export interface PublishedKey {
  key_id: string;
  alg: 'Ed25519';
  public_key: string;
  status: 'active' | 'retired' | 'revoked';
}

export type FailureCode =
  | 'SPEC_UNSUPPORTED' | 'MALFORMED' | 'MATCH_ID_MISMATCH' | 'EVENT_GAP' | 'EVENT_COUNT_MISMATCH'
  | 'HEAD_MISMATCH' | 'KEY_UNKNOWN' | 'KEY_REVOKED' | 'SIGNATURE_INVALID' | 'MOVES_MISMATCH';

export type Outcome =
  | { result: 'VERIFIED'; /** parts of the manifest this call did not check (the moves, when they were not supplied) */ unchecked?: string[] }
  | { result: 'UNVERIFIED' }
  | { result: 'FAILED'; code: FailureCode; detail?: Record<string, unknown> }
  | { result: 'ERROR'; code: 'UNSUPPORTED_ENVIRONMENT' | 'INTERNAL'; detail?: string };

// ---- small byte helpers (no Buffer) ---------------------------------------------------------------------------------

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const HEX = '0123456789abcdef';
export const toHex = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += HEX[b >> 4] + HEX[b & 15]; return s; };
export const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** base64url without padding; returns null for anything that is not canonical base64url. */
export const fromBase64Url = (text: string): Uint8Array | null => {
  if (typeof text !== 'string' || /[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    value = (value << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 255); }
  }
  return new Uint8Array(out);
};

// ---- the hash chain -------------------------------------------------------------------------------------------------

export const genesisHash = async (crypto: CryptoProvider, matchId: string): Promise<string> =>
  toHex(await crypto.sha256(concat(utf8(DOMAIN_GENESIS), utf8(matchId))));

const recordOf = (matchId: string, e: EventRecord) =>
  ({ v: 1, match_id: matchId, seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload });

export const eventHash = async (crypto: CryptoProvider, matchId: string, prevHash: string, e: EventRecord): Promise<string> =>
  toHex(await crypto.sha256(concat(utf8(DOMAIN_EVENT), fromHex(prevHash), utf8(canonicalize(recordOf(matchId, e))))));

/** Hashes of every event in order, and the head. Events must already be sorted by seq. */
export const chainHashes = async (crypto: CryptoProvider, matchId: string, events: EventRecord[]) => {
  const hashes: string[] = [];
  let prev = await genesisHash(crypto, matchId);
  for (const event of events) {
    prev = await eventHash(crypto, matchId, prev, event);
    hashes.push(prev);
  }
  return { hashes, head: prev };
};

// ---- the moves digest (provenance) ----------------------------------------------------------------------------------

/** One stored move. `provenance` is the per-move record (null when the move predates provenance). `content` is the raw text. */
export interface MoveRecord {
  move_index: number;
  actor_role: string;
  content: string;
  provenance: unknown;
}

export const movesGenesisHash = async (crypto: CryptoProvider, matchId: string): Promise<string> =>
  toHex(await crypto.sha256(concat(utf8(DOMAIN_MOVES_GENESIS), utf8(matchId))));

export const moveHash = async (crypto: CryptoProvider, matchId: string, prevHash: string, move: MoveRecord): Promise<string> => {
  const record = {
    v: 1, match_id: matchId, move_index: move.move_index, actor_role: move.actor_role,
    content_sha256: toHex(await crypto.sha256(utf8(move.content))), provenance: move.provenance ?? null
  };
  return toHex(await crypto.sha256(concat(utf8(DOMAIN_MOVE), fromHex(prevHash), utf8(canonicalize(record)))));
};

/** Hash chain over the moves in order (spec section 4.5). Moves must already be sorted by move_index. */
export const moveChainHashes = async (crypto: CryptoProvider, matchId: string, moves: MoveRecord[]) => {
  const hashes: string[] = [];
  let prev = await movesGenesisHash(crypto, matchId);
  for (const move of moves) {
    prev = await moveHash(crypto, matchId, prev, move);
    hashes.push(prev);
  }
  return { hashes, head: prev };
};

// ---- verification ---------------------------------------------------------------------------------------------------

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const wellFormedEvent = (e: any): boolean =>
  !!e && typeof e === 'object' && isInt(e.seq) && e.seq >= 0 && isInt(e.turn_index) && typeof e.type === 'string' &&
  (e.actor_role === null || typeof e.actor_role === 'string') && 'payload' in e;

/**
 * Runs the ten checks of spec section 7, in order, and stops at the first failure.
 * `envelope` is null/undefined when the match has no manifest. `keys` must come from a source the caller trusts.
 */
export const verifyMatch = async (
  crypto: CryptoProvider, matchId: string, events: EventRecord[], envelope: Envelope | null | undefined, keys: PublishedKey[],
  extra: { moves?: MoveRecord[] } = {}
): Promise<Outcome> => {
  const fail = (code: FailureCode, detail?: Record<string, unknown>): Outcome => ({ result: 'FAILED', code, ...(detail ? { detail } : {}) });
  try {
    if (envelope === null || envelope === undefined) return { result: 'UNVERIFIED' };
    const manifest = envelope.manifest as Record<string, any> | undefined;
    const signature = envelope.signature;
    // 1
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !signature || typeof signature !== 'object' || !Array.isArray(events) || !events.every(wellFormedEvent)) return fail('MALFORMED');
    // 2
    if (manifest.spec !== SPEC) return fail('SPEC_UNSUPPORTED');
    // 3
    if (manifest.match_id !== matchId) return fail('MATCH_ID_MISMATCH');
    // 4
    let signed: Uint8Array;
    try { signed = concat(utf8(DOMAIN_MANIFEST), utf8(canonicalize(manifest))); } catch (err) {
      if (err instanceof CanonicalizationError) return fail('MALFORMED', { reason: 'manifest', message: err.message });
      throw err;
    }
    // 5
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < ordered.length; i++) if (ordered[i].seq !== i) return fail('EVENT_GAP', { expectedSeq: i, foundSeq: ordered[i].seq });
    // 6
    if (!manifest.events || manifest.events.count !== ordered.length) return fail('EVENT_COUNT_MISMATCH', { manifest: manifest.events?.count, events: ordered.length });
    // 7
    let computed: { hashes: string[]; head: string };
    try { computed = await chainHashes(crypto, matchId, ordered); } catch (err) {
      if (err instanceof CanonicalizationError) return fail('MALFORMED', { reason: 'event', message: err.message });
      throw err;
    }
    if (manifest.events.head_hash !== computed.head) {
      // events that carry their own hash let us say where the log first stops matching (informational only)
      const first = ordered.findIndex((e, i) => typeof e.hash === 'string' && e.hash !== computed.hashes[i]);
      return fail('HEAD_MISMATCH', first === -1 ? undefined : { firstMismatchSeq: ordered[first].seq });
    }
    // 8, 9
    const key = keys.find(k => k && k.key_id === signature.key_id);
    if (!key) return fail('KEY_UNKNOWN');
    if (key.status === 'revoked') return fail('KEY_REVOKED');
    // 10
    if (manifest.key_id !== signature.key_id) return fail('SIGNATURE_INVALID');
    const publicKey = fromBase64Url(key.public_key);
    const sig = fromBase64Url(signature.sig);
    if (!publicKey || publicKey.length !== 32 || key.alg !== 'Ed25519') return fail('MALFORMED', { reason: 'key set' });
    if (toHex(await crypto.sha256(publicKey)).slice(0, 16) !== key.key_id) return fail('MALFORMED', { reason: 'key set', message: 'key id does not match the public key' });
    if (!sig || sig.length !== 64) return fail('SIGNATURE_INVALID');
    if (!(await crypto.ed25519Verify(publicKey, signed, sig))) return fail('SIGNATURE_INVALID');
    // 11 (only when the signed manifest commits to the moves): the stored moves and their provenance still match the digest
    const committed = manifest.provenance?.moves;
    if (committed) {
      if (!extra.moves) return { result: 'VERIFIED', unchecked: ['moves'] };
      if (!extra.moves.every(m => m && isInt(m.move_index) && m.move_index >= 0 && typeof m.actor_role === 'string' && typeof m.content === 'string')) return fail('MALFORMED', { reason: 'moves' });
      const moves = [...extra.moves].sort((a, b) => a.move_index - b.move_index);
      for (let i = 0; i < moves.length; i++) if (moves[i].move_index !== i) return fail('MOVES_MISMATCH', { reason: 'gap', expectedIndex: i, foundIndex: moves[i].move_index });
      if (committed.count !== moves.length) return fail('MOVES_MISMATCH', { reason: 'count', manifest: committed.count, moves: moves.length });
      let movesHead: string;
      try { movesHead = (await moveChainHashes(crypto, matchId, moves)).head; } catch (err) {
        if (err instanceof CanonicalizationError) return fail('MALFORMED', { reason: 'moves', message: err.message });
        throw err;
      }
      if (committed.head_hash !== movesHead) return fail('MOVES_MISMATCH', { reason: 'head' });
    }
    return { result: 'VERIFIED' };
  } catch (err) {
    const name = (err as Error)?.name;
    const message = String((err as Error)?.message || err);
    return { result: 'ERROR', code: name === 'NotSupportedError' || name === 'UnsupportedEnvironmentError' ? 'UNSUPPORTED_ENVIRONMENT' : 'INTERNAL', detail: message };
  }
};

export { HEX64 };
