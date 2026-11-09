/**
 * Checks docs/integrity/test-vectors.json against the reference implementation of docs/INTEGRITY_SPEC.md.
 * Regenerate the file after an intentional spec change with:  UPDATE_INTEGRITY_VECTORS=1 npx jest tests/integrity-spec.test.ts
 * (and bump the spec version if verification rules changed).
 */
import fs from 'fs';
import path from 'path';
import {
  CanonicalizationError, Envelope, EventRecord, FailureCode, PublicKeyEntry, SPEC, canonicalize, chain, genesisHash,
  keyId, publicKeyRawFromSeed, signManifest, verifyMatch
} from './helpers/integrity-reference';

const FILE = path.join(__dirname, '..', 'docs', 'integrity', 'test-vectors.json');

const MATCH_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_MATCH_ID = '99999999-8888-4777-8666-555555555555';
const SEED_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i));          // test key A: 00 01 02 ... 1f
const SEED_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));     // test key B: ff fe fd ... e0

const EVENTS: EventRecord[] = [
  { seq: 0, turn_index: 0, type: 'MATCH_START', actor_role: 'system', payload: { seed: 42, game: 'iterated-negotiation', ruleset_version: '1.0.0' } },
  { seq: 1, turn_index: 1, type: 'ACTION', actor_role: 'player1', payload: { action: 'propose', amount: 50, note: 'split 50/50 é😀' } },
  { seq: 2, turn_index: 2, type: 'GAME_END', actor_role: null, payload: { winner: 'player1', scores: { player1: 50, player2: 50 } } }
];

const keyEntry = (seed: Buffer, status: PublicKeyEntry['status'] = 'active'): PublicKeyEntry => {
  const raw = publicKeyRawFromSeed(seed);
  return { key_id: keyId(raw), alg: 'Ed25519', public_key: raw.toString('base64url'), status };
};

const manifestFor = (events: EventRecord[], seed: Buffer, overrides: Record<string, any> = {}) => ({
  spec: SPEC,
  key_id: keyId(publicKeyRawFromSeed(seed)),
  match_id: MATCH_ID,
  game_type: 'iterated-negotiation',
  ruleset_version: '1.0.0',
  seed: 42,
  status: 'COMPLETED',
  events: { count: events.length, head_hash: chain(MATCH_ID, events).head },
  started_at: '2026-11-08T12:00:00.000Z',
  finished_at: '2026-11-08T12:00:07.250Z',
  ...overrides
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const canonicalValid: { name: string; input_json: string }[] = [
  { name: 'object keys are sorted, nested objects too, array order is kept', input_json: '{"b":2,"a":1,"c":{"z":1,"y":[3,2,1]}}' },
  { name: 'insignificant whitespace is removed and integral floats lose their fraction', input_json: '{ "n": 1.0, "m": 1e2, "s": "x" }' },
  { name: 'number forms follow ECMAScript Number-to-String (negative zero becomes 0)', input_json: '[0.000001, 1e-7, 9007199254740991, -0, 0.1, 100, 1.5, -1e-9]' },
  { name: 'string escapes: short forms, lowercase \\u for other control characters, everything else literal', input_json: '"line\\nbreak \\"quote\\" \\\\ tab\\t bell\\u0007 del\\u007f \\u00e9 \\ud83d\\ude00"' },
  { name: 'keys sort by UTF-16 code unit, not by code point', input_json: '{"\\ud83d\\ude00":1,"\\uffff":2,"a":3}' },
  { name: 'null, booleans, empty containers', input_json: '{"d":{},"c":[],"b":true,"a":null}' }
];
const canonicalInvalid: { name: string; input_json: string }[] = [
  { name: 'lone surrogate in a string', input_json: '"\\ud800"' },
  { name: 'integer outside the safe range (2^53 + 1 parses to 2^53)', input_json: '9007199254740993' },
  { name: 'number that overflows to infinity', input_json: '1e400' },
  { name: 'large integral number (1e21)', input_json: '1e21' }
];

const verification = (): { name: string; match_id: string; events: EventRecord[]; envelope: Envelope; keys: PublicKeyEntry[]; expect: { result: 'VERIFIED' } | { result: 'FAILED'; code: FailureCode } }[] => {
  const good = signManifest(manifestFor(EVENTS, SEED_A), SEED_A);
  const keysA = [keyEntry(SEED_A)];
  const tamperedPayload = clone(EVENTS); (tamperedPayload[1].payload as any).amount = 51;
  const swapped = clone(EVENTS); swapped[1] = { ...EVENTS[2], seq: 1 }; swapped[2] = { ...EVENTS[1], seq: 2 };
  const forgedSig: Envelope = { ...clone(good), signature: { ...signManifest(good.manifest, SEED_B).signature, key_id: good.signature.key_id } };
  return [
    { name: 'untouched match verifies', match_id: MATCH_ID, events: EVENTS, envelope: good, keys: keysA, expect: { result: 'VERIFIED' } },
    { name: 'events may be supplied in any order', match_id: MATCH_ID, events: [EVENTS[2], EVENTS[0], EVENTS[1]], envelope: good, keys: keysA, expect: { result: 'VERIFIED' } },
    { name: 'a signature from a retired key still verifies', match_id: MATCH_ID, events: EVENTS, envelope: good, keys: [keyEntry(SEED_A, 'retired')], expect: { result: 'VERIFIED' } },
    { name: 'a changed event payload breaks the chain', match_id: MATCH_ID, events: tamperedPayload, envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'HEAD_MISMATCH' } },
    { name: 'two events exchanged between positions break the chain', match_id: MATCH_ID, events: swapped, envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'HEAD_MISMATCH' } },
    { name: 'a removed last event changes the count', match_id: MATCH_ID, events: EVENTS.slice(0, 2), envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'EVENT_COUNT_MISMATCH' } },
    { name: 'a removed middle event leaves a gap in seq', match_id: MATCH_ID, events: [EVENTS[0], EVENTS[2]], envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'EVENT_GAP' } },
    { name: 'an appended event changes the count', match_id: MATCH_ID, events: [...EVENTS, { seq: 3, turn_index: 3, type: 'ACTION', actor_role: 'player2', payload: {} }], envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'EVENT_COUNT_MISMATCH' } },
    { name: 'a changed manifest field invalidates the signature', match_id: MATCH_ID, events: EVENTS, envelope: { ...clone(good), manifest: { ...good.manifest, status: 'FAILED' } }, keys: keysA, expect: { result: 'FAILED', code: 'SIGNATURE_INVALID' } },
    { name: 'a signature made by another key is rejected', match_id: MATCH_ID, events: EVENTS, envelope: forgedSig, keys: keysA, expect: { result: 'FAILED', code: 'SIGNATURE_INVALID' } },
    { name: 'an unknown key id is rejected', match_id: MATCH_ID, events: EVENTS, envelope: good, keys: [keyEntry(SEED_B)], expect: { result: 'FAILED', code: 'KEY_UNKNOWN' } },
    { name: 'a revoked key is rejected', match_id: MATCH_ID, events: EVENTS, envelope: good, keys: [keyEntry(SEED_A, 'revoked')], expect: { result: 'FAILED', code: 'KEY_REVOKED' } },
    { name: 'an unsupported spec version is rejected', match_id: MATCH_ID, events: EVENTS, envelope: signManifest(manifestFor(EVENTS, SEED_A, { spec: 'arena-integrity/2' }), SEED_A), keys: keysA, expect: { result: 'FAILED', code: 'SPEC_UNSUPPORTED' } },
    ...(() => {
      const members = { engine: { kind: 'SANDBOXED', key: 'custom-game', artifact_id: 'artifact-1', sha256: 'c'.repeat(64), contract_version: 1 }, options: { maxPlies: 40, allowDraws: true }, options_sha256: 'd'.repeat(64) };
      const withMembers = signManifest(manifestFor(EVENTS, SEED_A, members), SEED_A);
      const changedEngine = { ...clone(withMembers), manifest: { ...withMembers.manifest, engine: { ...members.engine, sha256: 'e'.repeat(64) } } };
      const { engine: _engine, ...withoutEngine } = withMembers.manifest;
      return [
        { name: 'optional engine and options members are covered by the signature and verify', match_id: MATCH_ID, events: EVENTS, envelope: withMembers, keys: keysA, expect: { result: 'VERIFIED' } as const },
        { name: 'a changed engine hash invalidates the signature', match_id: MATCH_ID, events: EVENTS, envelope: changedEngine, keys: keysA, expect: { result: 'FAILED', code: 'SIGNATURE_INVALID' } as const },
        { name: 'a removed engine member invalidates the signature', match_id: MATCH_ID, events: EVENTS, envelope: { ...clone(withMembers), manifest: withoutEngine }, keys: keysA, expect: { result: 'FAILED', code: 'SIGNATURE_INVALID' } as const },
        { name: 'members a verifier does not know are ignored by it but still signed', match_id: MATCH_ID, events: EVENTS, envelope: signManifest(manifestFor(EVENTS, SEED_A, { future_member: { anything: [1, 2, 3] } }), SEED_A), keys: keysA, expect: { result: 'VERIFIED' } as const }
      ];
    })(),
    { name: 'a manifest for another match is rejected', match_id: OTHER_MATCH_ID, events: EVENTS, envelope: good, keys: keysA, expect: { result: 'FAILED', code: 'MATCH_ID_MISMATCH' } }
  ];
};

const buildVectors = () => ({
  spec: SPEC,
  description: 'Known-answer vectors for docs/INTEGRITY_SPEC.md. Hex is lowercase. Keys here are TEST KEYS ONLY and must never be used for real signatures.',
  canonicalization: {
    valid: canonicalValid.map(v => ({ ...v, canonical: canonicalize(JSON.parse(v.input_json)) })),
    invalid: canonicalInvalid.map(v => ({ ...v, rejected: true }))
  },
  genesis: [MATCH_ID, OTHER_MATCH_ID].map(id => ({ match_id: id, hash: genesisHash(id) })),
  chains: [
    { name: 'empty log: the head is the genesis hash', match_id: MATCH_ID, events: [], hashes: [], head: genesisHash(MATCH_ID) },
    { name: 'three events', match_id: MATCH_ID, events: EVENTS, ...chain(MATCH_ID, EVENTS) },
    { name: 'same events under another match id give a different chain', match_id: OTHER_MATCH_ID, events: EVENTS, ...chain(OTHER_MATCH_ID, EVENTS) }
  ],
  test_keys: [
    { name: 'A', seed_hex: SEED_A.toString('hex'), public_key: publicKeyRawFromSeed(SEED_A).toString('base64url'), key_id: keyId(publicKeyRawFromSeed(SEED_A)) },
    { name: 'B', seed_hex: SEED_B.toString('hex'), public_key: publicKeyRawFromSeed(SEED_B).toString('base64url'), key_id: keyId(publicKeyRawFromSeed(SEED_B)) }
  ],
  verification: verification()
});

describe('integrity spec: test vectors', () => {
  const vectors = buildVectors();

  if (process.env.UPDATE_INTEGRITY_VECTORS === '1') {
    it('rewrites the vector file', () => {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(vectors, null, 2) + '\n');
    });
    return;
  }

  const published = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  it('the published file is exactly what the reference implementation produces', () => {
    expect(published).toEqual(vectors);
  });

  it('has at least five vectors of every kind', () => {
    expect(published.canonicalization.valid.length).toBeGreaterThanOrEqual(5);
    expect(published.chains.length).toBeGreaterThanOrEqual(3);
    expect(published.verification.length).toBeGreaterThanOrEqual(5);
    expect(new Set(published.verification.map((v: any) => v.expect.code)).size).toBeGreaterThanOrEqual(5);
  });

  describe('canonicalization', () => {
    it.each<any>(published.canonicalization.valid)('$name', (v: any) => {
      expect(canonicalize(JSON.parse(v.input_json))).toBe(v.canonical);
    });
    it.each<any>(published.canonicalization.invalid)('rejects: $name', (v: any) => {
      expect(() => canonicalize(JSON.parse(v.input_json))).toThrow(CanonicalizationError);
    });
    it('rejects undefined values, non-plain objects and unsupported types', () => {
      expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
      expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
      expect(() => canonicalize(() => 1)).toThrow(CanonicalizationError);
      expect(() => canonicalize(BigInt(1))).toThrow(CanonicalizationError);
    });
  });

  describe('hash chain', () => {
    it.each<any>(published.genesis)('genesis hash for $match_id', (v: any) => {
      expect(genesisHash(v.match_id)).toBe(v.hash);
    });
    it.each<any>(published.chains)('$name', (v: any) => {
      const { hashes, head } = chain(v.match_id, v.events);
      expect(hashes).toEqual(v.hashes);
      expect(head).toBe(v.head);
    });
    it('every event hash depends on everything before it', () => {
      const base = chain(MATCH_ID, EVENTS).hashes;
      const changed = clone(EVENTS); (changed[0].payload as any).seed = 43;
      const after = chain(MATCH_ID, changed).hashes;
      base.forEach((h, i) => expect(after[i]).not.toBe(h));
    });
    it('the created_at and database id of a row are not part of the hash', () => {
      const decorated = EVENTS.map(e => ({ ...e, id: 'row-1', created_at: new Date() })) as EventRecord[];
      expect(chain(MATCH_ID, decorated).head).toBe(chain(MATCH_ID, EVENTS).head);
    });
  });

  describe('verification', () => {
    it.each<any>(published.verification)('$name', (v: any) => {
      expect(verifyMatch(v.match_id, v.events, v.envelope, v.keys)).toEqual(v.expect);
    });
  });

  describe('test keys', () => {
    it('are derived from the published seeds', () => {
      for (const k of published.test_keys) {
        const raw = publicKeyRawFromSeed(Buffer.from(k.seed_hex, 'hex'));
        expect(raw.toString('base64url')).toBe(k.public_key);
        expect(keyId(raw)).toBe(k.key_id);
      }
    });
  });
});
