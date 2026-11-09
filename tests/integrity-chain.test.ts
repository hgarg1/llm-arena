/**
 * The production hash-chain code (src/integrity) against the spec's published vectors and against the independent
 * reference implementation in tests/helpers, plus the append rules the runner depends on.
 */
import fs from 'fs';
import path from 'path';
import { CanonicalizationError, canonicalize, chain, eventHash, genesisHash } from '../src/integrity/hash-chain';
import { IntegrityError, chainAppend, storedPayload } from '../src/integrity/append';
import * as reference from './helpers/integrity-reference';

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'integrity', 'test-vectors.json'), 'utf8'));
const MATCH = '11111111-2222-4333-8444-555555555555';

describe('production hash chain reproduces the published vectors', () => {
  it.each<any>(vectors.canonicalization.valid)('canonical form: $name', v => {
    expect(canonicalize(JSON.parse(v.input_json))).toBe(v.canonical);
  });
  it.each<any>(vectors.canonicalization.invalid)('rejects: $name', v => {
    expect(() => canonicalize(JSON.parse(v.input_json))).toThrow(CanonicalizationError);
  });
  it.each<any>(vectors.genesis)('genesis hash for $match_id', v => {
    expect(genesisHash(v.match_id)).toBe(v.hash);
  });
  it.each<any>(vectors.chains)('chain: $name', v => {
    const { hashes, head } = chain(v.match_id, v.events);
    expect(hashes).toEqual(v.hashes);
    expect(head).toBe(v.head);
  });
});

/** Small deterministic PRNG so the random cases are reproducible. */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const randomValue = (rand: () => number, depth = 0): unknown => {
  const kind = Math.floor(rand() * (depth > 2 ? 5 : 7));
  switch (kind) {
    case 0: return null;
    case 1: return rand() < 0.5;
    case 2: return Math.floor(rand() * 2000) - 1000;
    case 3: return Math.round((rand() - 0.5) * 1e6) / 1000;
    case 4: return ['plain', 'café', 'emoji 😀', 'quote " slash \\ tab \t', '\u0001ctl', ''][Math.floor(rand() * 6)];
    case 5: return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
    default: {
      const keys = ['b', 'a', 'z', 'é', '😀', '￿', 'key with space', '0', '10', '9'];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 5); i++) out[keys[Math.floor(rand() * keys.length)]] = randomValue(rand, depth + 1);
      return out;
    }
  }
};

describe('production hash chain agrees with the independent reference implementation', () => {
  it('on 300 random payloads and chains', () => {
    const rand = prng(12345);
    for (let i = 0; i < 300; i++) {
      const payload = randomValue(rand);
      expect(canonicalize(payload)).toBe(reference.canonicalize(payload));
      const events = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, seq) => ({
        seq, turn_index: seq, type: rand() < 0.5 ? 'ACTION' : 'STEP', actor_role: rand() < 0.2 ? null : 'player1', payload: randomValue(rand)
      }));
      const id = `match-${i}`;
      expect(chain(id, events)).toEqual(reference.chain(id, events));
    }
  });
});

describe('chainAppend', () => {
  const row = (seq: number, payload: unknown = { n: seq }) => ({ turn_index: seq, seq, type: 'STEP', actor_role: 'player1', payload });

  it('starts at the genesis hash for an empty log and chains consecutively', () => {
    const out = chainAppend(MATCH, null, [row(0), row(1), row(2)]);
    const ref = reference.chain(MATCH, [row(0), row(1), row(2)]);
    expect(out.map(r => r.hash)).toEqual(ref.hashes);
    expect(out[0].prev_hash).toBe(genesisHash(MATCH));
    expect(out[1].prev_hash).toBe(out[0].hash);
    expect(out[2].prev_hash).toBe(out[1].hash);
  });

  it('appending in several calls gives the same chain as one call', () => {
    const rows = [0, 1, 2, 3, 4, 5].map(seq => row(seq));
    const whole = chainAppend(MATCH, null, rows);
    let tail: { seq: number; hash: string | null } | null = null;
    const pieces: Array<(typeof whole)[number]> = [];
    for (const split of [[0, 1], [2], [3, 4, 5]]) {
      const added: Array<(typeof whole)[number]> = chainAppend(MATCH, tail, split.map(seq => rows[seq]));
      pieces.push(...added);
      tail = { seq: added[added.length - 1].seq, hash: added[added.length - 1].hash };
    }
    expect(pieces).toEqual(whole);
  });

  it('orders rows by seq before chaining, so the order a caller lists them in does not matter', () => {
    const shuffled = chainAppend(MATCH, null, [row(2), row(0), row(1)]);
    expect(shuffled.map(r => r.seq)).toEqual([0, 1, 2]);
    expect(shuffled.map(r => r.hash)).toEqual(reference.chain(MATCH, [row(0), row(1), row(2)]).hashes);
  });

  it('returns nothing for nothing', () => {
    expect(chainAppend(MATCH, null, [])).toEqual([]);
  });

  it('leaves a match unchained when its stored events predate chaining', () => {
    const out = chainAppend(MATCH, { seq: 4, hash: null }, [row(5), row(6)]);
    expect(out.map(r => [r.hash, r.prev_hash])).toEqual([[null, null], [null, null]]);
    expect(out.map(r => r.seq)).toEqual([5, 6]);
  });

  it('rejects a gap, a repeat, or a non-consecutive batch', () => {
    const tail = { seq: 3, hash: 'a'.repeat(64) };
    expect(() => chainAppend(MATCH, tail, [row(5)])).toThrow(IntegrityError); // gap
    expect(() => chainAppend(MATCH, tail, [row(3)])).toThrow(IntegrityError); // repeat
    expect(() => chainAppend(MATCH, tail, [row(4), row(6)])).toThrow(IntegrityError); // gap inside the batch
    expect(() => chainAppend(MATCH, null, [row(1)])).toThrow(IntegrityError); // a log starts at seq 0
  });

  it('hashes the payload as it will be read back from storage', () => {
    const messy = { keep: 1, drop: undefined, when: new Date('2026-11-08T12:00:00.000Z'), nan: NaN, nested: { x: undefined, y: [1, undefined] } };
    const [out] = chainAppend(MATCH, null, [row(0, messy)]);
    const readBack = JSON.parse(JSON.stringify(messy));
    expect(out.payload).toEqual(readBack);
    expect(out.hash).toBe(reference.chain(MATCH, [{ ...row(0), payload: readBack }]).head);
  });

  it('treats a missing payload as an empty object', () => {
    expect(storedPayload(undefined)).toEqual({});
    const [out] = chainAppend(MATCH, null, [{ turn_index: 0, seq: 0, type: 'STEP', actor_role: 'system', payload: undefined }]);
    expect(out.payload).toEqual({});
  });

  it('refuses events that cannot be hashed instead of storing them unchained', () => {
    expect(() => chainAppend(MATCH, null, [row(0, { big: 2 ** 60 })])).toThrow(/cannot be hashed/);
    expect(() => chainAppend(MATCH, null, [row(0, { s: '\ud800' })])).toThrow(IntegrityError);
  });

  it('eventHash rejects a malformed previous hash', () => {
    expect(() => eventHash(MATCH, 'nothex', row(0))).toThrow(CanonicalizationError);
  });
});
