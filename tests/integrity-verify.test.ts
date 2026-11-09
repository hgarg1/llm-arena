/**
 * The verification library (src/integrity/verify.ts) with both crypto providers, against the published vectors, a tamper
 * matrix, and the independent reference implementation. The library must reproduce every vector in
 * docs/integrity/test-vectors.json, in Node and with WebCrypto.
 */
import fs from 'fs';
import path from 'path';
import { chain as productionChain } from '../src/integrity/hash-chain';
import { signManifest, signerFromSeed, buildManifest } from '../src/integrity/signing';
import { CryptoProvider, EventRecord, Envelope, PublishedKey, chainHashes, fromBase64Url, fromHex, genesisHash, moveChainHashes, toHex, verifyMatch } from '../src/integrity/verify';
import { nodeProvider } from '../src/integrity/verify-node';
import { webProvider } from '../src/integrity/verify-web';
import * as reference from './helpers/integrity-reference';

const root = path.join(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'integrity', 'test-vectors.json'), 'utf8'));
const PROVIDERS: Array<[string, CryptoProvider]> = [['node crypto', nodeProvider], ['WebCrypto', webProvider]];

const SEED_A = Buffer.from(vectors.test_keys[0].seed_hex, 'hex');
const SEED_B = Buffer.from(vectors.test_keys[1].seed_hex, 'hex');
const entry = (seed: Buffer, status: PublishedKey['status'] = 'active'): PublishedKey => {
  const e = reference.publicKeyRawFromSeed(seed);
  return { key_id: reference.keyId(e), alg: 'Ed25519', public_key: e.toString('base64url'), status };
};

describe.each(PROVIDERS)('verification library with %s', (_name, provider) => {
  it.each<any>(vectors.genesis)('genesis hash for $match_id', async v => {
    expect(await genesisHash(provider, v.match_id)).toBe(v.hash);
  });

  it.each<any>(vectors.chains)('chain: $name', async v => {
    const { hashes, head } = await chainHashes(provider, v.match_id, v.events);
    expect(hashes).toEqual(v.hashes);
    expect(head).toBe(v.head);
  });

  it.each<any>(vectors.moves_chains)('moves chain: $name', async v => {
    const { hashes, head } = await moveChainHashes(provider, v.match_id, v.moves);
    expect(hashes).toEqual(v.hashes);
    expect(head).toBe(v.head);
  });

  it.each<any>(vectors.verification)('verification vector: $name', async v => {
    const outcome = await verifyMatch(provider, v.match_id, v.events, v.envelope, v.keys, { moves: v.moves });
    expect(outcome.result).toBe(v.expect.result);
    expect((outcome as any).code).toBe(v.expect.code);
  });
});

/** A realistic signed match: the vectors' three-event log, signed by the production signer. */
const MATCH = '11111111-2222-4333-8444-555555555555';
const EVENTS: EventRecord[] = vectors.chains[1].events;
const signedFor = async (matchId: string, events: EventRecord[], seed = SEED_A, overrides: Record<string, unknown> = {}): Promise<Envelope> => {
  const signer = signerFromSeed(seed.toString('base64url'));
  const manifest = buildManifest({
    matchId, keyId: signer.keyId, gameType: 'chess', rulesetVersion: '1.0.0', seed: 7, status: 'COMPLETED', eventCount: events.length,
    headHash: productionChain(matchId, events).head, startedAt: new Date('2026-11-08T12:00:00.000Z'), finishedAt: new Date('2026-11-08T12:00:09.000Z'), ...overrides
  } as any);
  return signManifest(manifest, signer) as unknown as Envelope;
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const verify = (events: EventRecord[], envelope: Envelope | null, keys = [entry(SEED_A)], matchId = MATCH) => verifyMatch(nodeProvider, matchId, events, envelope, keys);
const failed = (code: string) => expect.objectContaining({ result: 'FAILED', code });

describe('tamper matrix', () => {
  let good: Envelope;
  beforeAll(async () => { good = await signedFor(MATCH, EVENTS); });

  it('the untouched match verifies, whatever order the events arrive in', async () => {
    expect(await verify(EVENTS, good)).toEqual({ result: 'VERIFIED' });
    expect(await verify([...EVENTS].reverse(), good)).toEqual({ result: 'VERIFIED' });
  });

  describe('changed events', () => {
    it.each(EVENTS.map((_, i) => i))('a changed payload in event %i', async i => {
      const events = clone(EVENTS); (events[i].payload as any).tampered = true;
      expect(await verify(events, good)).toEqual(failed('HEAD_MISMATCH'));
    });
    it.each(['type', 'actor_role', 'turn_index'] as const)('a changed %s', async field => {
      const events = clone(EVENTS);
      (events[1] as any)[field] = field === 'turn_index' ? 99 : field === 'actor_role' ? 'player2' : 'OTHER';
      expect(await verify(events, good)).toEqual(failed('HEAD_MISMATCH'));
    });
    it('a payload value changed only in its type (1 vs "1")', async () => {
      const events = clone(EVENTS); events[1].payload = { ...(events[1].payload as any), amount: String((events[1].payload as any).amount) };
      expect(await verify(events, good)).toEqual(failed('HEAD_MISMATCH'));
    });
  });

  describe('removed events', () => {
    it('the last one', async () => expect(await verify(EVENTS.slice(0, 2), good)).toEqual(failed('EVENT_COUNT_MISMATCH')));
    it('a middle one leaves a gap', async () => expect(await verify([EVENTS[0], EVENTS[2]], good)).toEqual(failed('EVENT_GAP')));
    it('the first one', async () => expect(await verify(EVENTS.slice(1), good)).toEqual(failed('EVENT_GAP')));
    it('all of them', async () => expect(await verify([], good)).toEqual(failed('EVENT_COUNT_MISMATCH')));
    it('one removed and the count patched in the manifest: the signature catches it', async () => {
      const events = EVENTS.slice(0, 2);
      const patched = { manifest: { ...good.manifest, events: { count: 2, head_hash: productionChain(MATCH, events).head } }, signature: good.signature };
      expect(await verify(events, patched)).toEqual(failed('SIGNATURE_INVALID'));
    });
  });

  describe('reordered events', () => {
    it('two events exchanging their positions (seq values swapped)', async () => {
      const events = clone(EVENTS); events[1].seq = 2; events[2].seq = 1;
      expect(await verify(events, good)).toEqual(failed('HEAD_MISMATCH'));
    });
    it('two events exchanging their contents', async () => {
      const events = clone(EVENTS); [events[0].payload, events[1].payload] = [events[1].payload, events[0].payload];
      expect(await verify(events, good)).toEqual(failed('HEAD_MISMATCH'));
    });
    it('an event moved to another position and renumbered', async () => {
      const moved = [EVENTS[1], EVENTS[0], EVENTS[2]].map((e, i) => ({ ...clone(e), seq: i }));
      expect(await verify(moved, good)).toEqual(failed('HEAD_MISMATCH'));
    });
  });

  describe('appended events', () => {
    const extra = (seq: number): EventRecord => ({ seq, turn_index: seq, type: 'EXTRA', actor_role: 'system', payload: {} });
    it('one more event', async () => expect(await verify([...EVENTS, extra(3)], good)).toEqual(failed('EVENT_COUNT_MISMATCH')));
    it('a duplicate of an existing event', async () => expect(await verify([...EVENTS, clone(EVENTS[2])], good)).toEqual(failed('EVENT_GAP')));
    it('one appended and the count patched: the signature catches it', async () => {
      const events = [...EVENTS, extra(3)];
      const patched = { manifest: { ...good.manifest, events: { count: 4, head_hash: productionChain(MATCH, events).head } }, signature: good.signature };
      expect(await verify(events, patched)).toEqual(failed('SIGNATURE_INVALID'));
    });
  });

  describe('forged or swapped signatures', () => {
    it('a signature with one bit flipped', async () => {
      const sig = Buffer.from(good.signature.sig, 'base64url'); sig[10] ^= 1;
      expect(await verify(EVENTS, { ...good, signature: { ...good.signature, sig: sig.toString('base64url') } })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('a signature of the wrong length, and one that is not base64url', async () => {
      expect(await verify(EVENTS, { ...good, signature: { ...good.signature, sig: 'AAAA' } })).toEqual(failed('SIGNATURE_INVALID'));
      expect(await verify(EVENTS, { ...good, signature: { ...good.signature, sig: '!!!!' } })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('a signature made by another key under this key id', async () => {
      const other = await signedFor(MATCH, EVENTS, SEED_B);
      expect(await verify(EVENTS, { manifest: good.manifest, signature: { ...other.signature, key_id: good.signature.key_id } })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('a valid signature taken from another match (same key, same size of log)', async () => {
      const otherId = '99999999-8888-4777-8666-555555555555';
      const otherEvents = EVENTS.map(e => clone(e));
      const other = await signedFor(otherId, otherEvents);
      expect(await verify(EVENTS, { manifest: good.manifest, signature: other.signature })).toEqual(failed('SIGNATURE_INVALID'));
      expect(await verify(otherEvents, other, [entry(SEED_A)], otherId)).toEqual({ result: 'VERIFIED' });
      expect(await verify(EVENTS, other)).toEqual(failed('MATCH_ID_MISMATCH')); // and the whole bundle of another match is refused
    });
    it('a signature from the same key over a different manifest (a manifest swap)', async () => {
      const other = await signedFor(MATCH, EVENTS, SEED_A, { status: 'FAILED' });
      expect(await verify(EVENTS, { manifest: good.manifest, signature: other.signature })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('the events of a different match under this match\'s manifest', async () => {
      const otherId = '99999999-8888-4777-8666-555555555555';
      expect(await verify(EVENTS, good, [entry(SEED_A)], otherId)).toEqual(failed('MATCH_ID_MISMATCH'));
    });
  });

  describe('changed manifests', () => {
    it.each(['status', 'seed', 'game_type', 'ruleset_version', 'started_at', 'finished_at'])('a changed %s', async field => {
      const manifest = clone(good.manifest); manifest[field] = field === 'seed' ? 8 : 'changed';
      expect(await verify(EVENTS, { manifest, signature: good.signature })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('a member added to the manifest', async () => {
      expect(await verify(EVENTS, { manifest: { ...good.manifest, note: 'added later' }, signature: good.signature })).toEqual(failed('SIGNATURE_INVALID'));
    });
    it('a member removed from the manifest', async () => {
      const manifest = clone(good.manifest); delete manifest.started_at;
      expect(await verify(EVENTS, { manifest, signature: good.signature })).toEqual(failed('SIGNATURE_INVALID'));
    });
  });

  describe('keys', () => {
    it('unknown, revoked, and swapped-in keys', async () => {
      expect(await verify(EVENTS, good, [entry(SEED_B)])).toEqual(failed('KEY_UNKNOWN'));
      expect(await verify(EVENTS, good, [entry(SEED_A, 'revoked')])).toEqual(failed('KEY_REVOKED'));
      expect(await verify(EVENTS, good, [entry(SEED_A, 'retired')])).toEqual({ result: 'VERIFIED' });
    });
    it('a key set entry whose key id does not match its public key is not trusted', async () => {
      const lying = { ...entry(SEED_B), key_id: entry(SEED_A).key_id }; // B's key published under A's id
      expect(await verify(EVENTS, good, [lying])).toEqual(failed('MALFORMED'));
    });
    it('a manifest naming one key while the signature names another', async () => {
      const manifest = { ...good.manifest, key_id: entry(SEED_B).key_id };
      expect(await verify(EVENTS, { manifest, signature: good.signature }, [entry(SEED_A), entry(SEED_B)])).toEqual(failed('SIGNATURE_INVALID'));
    });
  });
});

describe('moves and their provenance', () => {
  const withMoves = vectors.verification.find((v: any) => v.name.startsWith('a manifest that commits to the moves'));
  const run = (moves?: any[]) => verifyMatch(nodeProvider, withMoves.match_id, withMoves.events, withMoves.envelope, withMoves.keys, moves ? { moves } : {});

  it('are checked against the signed digest when supplied', async () => {
    expect(await run(withMoves.moves)).toEqual({ result: 'VERIFIED' });
  });

  it('are reported as unchecked, not silently passed, when they are not supplied', async () => {
    expect(await run()).toEqual({ result: 'VERIFIED', unchecked: ['moves'] });
  });

  it('a manifest that does not commit to moves reports nothing unchecked', async () => {
    const plain = vectors.verification[0];
    expect(await verifyMatch(nodeProvider, plain.match_id, plain.events, plain.envelope, plain.keys)).toEqual({ result: 'VERIFIED' });
  });

  it.each<[string, (moves: any[]) => any[], string]>([
    ['a provenance field edited', m => { m[0].provenance.model.reported = 'other-model'; return m; }, 'head'],
    ['a provenance field added', m => { m[0].provenance.extra = true; return m; }, 'head'],
    ['a provenance record removed (null)', m => { m[1].provenance = null; return m; }, 'head'],
    ['the move text edited', m => { m[2].content = 'RESOLVE '; return m; }, 'head'],
    ['the actor changed', m => { m[0].actor_role = 'player2'; return m; }, 'head'],
    ['a move removed from the end', m => m.slice(0, 2), 'count'],
    ['a move appended', m => [...m, { move_index: 3, actor_role: 'player1', content: 'x', provenance: null }], 'count'],
    ['a gap in the numbering', m => [m[0], m[2]], 'gap'],
    ['a duplicate index', m => [m[0], m[0], m[1]], 'gap']
  ])('%s is detected', async (_label, mutate, reason) => {
    const moves = mutate(JSON.parse(JSON.stringify(withMoves.moves)));
    expect(await run(moves)).toMatchObject({ result: 'FAILED', code: 'MOVES_MISMATCH', detail: { reason } });
  });

  it('moves in any order give the same verdict', async () => {
    expect(await run([...withMoves.moves].reverse())).toEqual({ result: 'VERIFIED' });
  });

  it('a move that cannot be canonicalized is MALFORMED, not a pass', async () => {
    const moves = JSON.parse(JSON.stringify(withMoves.moves)); moves[0].provenance = { big: 2 ** 60 };
    expect(await run(moves)).toMatchObject({ result: 'FAILED', code: 'MALFORMED' });
    expect(await run([{ move_index: 'x' }] as any)).toMatchObject({ result: 'FAILED', code: 'MALFORMED' });
  });

  it('forging the digest in the manifest breaks the signature before the moves are even compared', async () => {
    const forged = JSON.parse(JSON.stringify(withMoves.envelope)); forged.manifest.provenance.moves.count = 2;
    expect(await verifyMatch(nodeProvider, withMoves.match_id, withMoves.events, forged, withMoves.keys, { moves: withMoves.moves.slice(0, 2) })).toMatchObject({ result: 'FAILED', code: 'SIGNATURE_INVALID' });
  });
});

describe('outcomes other than pass and fail', () => {
  it('no manifest is UNVERIFIED, never FAILED and never VERIFIED', async () => {
    expect(await verify(EVENTS, null)).toEqual({ result: 'UNVERIFIED' });
    expect(await verifyMatch(nodeProvider, MATCH, EVENTS, undefined, [])).toEqual({ result: 'UNVERIFIED' });
  });

  it('an environment without Ed25519 is an ERROR, never a pass or a fail', async () => {
    const good = await signedFor(MATCH, EVENTS);
    const noEd = { ...nodeProvider, ed25519Verify: async () => { const e = new Error('no ed25519'); e.name = 'UnsupportedEnvironmentError'; throw e; } };
    expect(await verifyMatch(noEd, MATCH, EVENTS, good, [entry(SEED_A)])).toEqual({ result: 'ERROR', code: 'UNSUPPORTED_ENVIRONMENT', detail: 'no ed25519' });
    const broken = { ...nodeProvider, sha256: () => { throw new Error('boom'); } };
    expect(await verifyMatch(broken, MATCH, EVENTS, good, [entry(SEED_A)])).toMatchObject({ result: 'ERROR', code: 'INTERNAL' });
  });

  it.each<[string, any, any]>([
    ['events that are not an array', null, undefined],
    ['an event without a seq', [{ turn_index: 0, type: 'X', actor_role: null, payload: {} }], undefined],
    ['an event with a fractional seq', [{ seq: 0.5, turn_index: 0, type: 'X', actor_role: null, payload: {} }], undefined],
    ['an event without a payload', [{ seq: 0, turn_index: 0, type: 'X', actor_role: null }], undefined],
    ['an envelope with no signature', EVENTS, { manifest: {} }],
    ['a manifest that is an array', EVENTS, { manifest: [], signature: {} }]
  ])('malformed input: %s', async (_label, events, envelope) => {
    const good = await signedFor(MATCH, EVENTS);
    const outcome = await verifyMatch(nodeProvider, MATCH, events ?? (undefined as any), envelope ?? good, [entry(SEED_A)]);
    expect(outcome).toEqual(failed('MALFORMED'));
  });

  it('an event payload that cannot be canonicalized is MALFORMED', async () => {
    const good = await signedFor(MATCH, EVENTS);
    const events = clone(EVENTS); events[1].payload = { big: 2 ** 60 };
    expect(await verify(events, good)).toEqual(failed('MALFORMED'));
  });

  it('events carrying their stored hash let the library point at the first one that no longer matches', async () => {
    const good = await signedFor(MATCH, EVENTS);
    const hashes = productionChain(MATCH, EVENTS).hashes;
    const events = EVENTS.map((e, i) => ({ ...clone(e), hash: hashes[i] }));
    (events[1].payload as any).amount = 51;
    const outcome = await verify(events, good);
    expect(outcome).toEqual({ result: 'FAILED', code: 'HEAD_MISMATCH', detail: { firstMismatchSeq: 1 } });
  });
});

describe('agrees with the independent reference implementation on random tampering', () => {
  it('600 random mutations give the same verdict and the same failure code', async () => {
    let state = 424242;
    const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
    const base = await signedFor(MATCH, EVENTS);
    const keysets = [[entry(SEED_A)], [entry(SEED_A, 'retired'), entry(SEED_B)], [entry(SEED_A, 'revoked')], [entry(SEED_B)]];

    for (let i = 0; i < 600; i++) {
      const events = clone(EVENTS);
      const envelope = clone(base) as Envelope;
      const keys = pick(keysets);
      let matchId = MATCH;
      for (let m = 0; m < Math.floor(rand() * 3); m++) {
        switch (Math.floor(rand() * 11)) {
          case 0: (pick(events).payload as any).k = rand(); break;
          case 1: events.splice(Math.floor(rand() * events.length), 1); break;
          case 2: events.push({ seq: events.length, turn_index: 9, type: 'EXTRA', actor_role: 'system', payload: {} }); break;
          case 3: { const a = pick(events), b = pick(events); [a.seq, b.seq] = [b.seq, a.seq]; break; }
          case 4: pick(events).type = 'CHANGED'; break;
          case 5: envelope.manifest.status = 'FAILED'; break;
          case 6: { const s = Buffer.from(envelope.signature.sig, 'base64url'); s[Math.floor(rand() * s.length)] ^= 1 << Math.floor(rand() * 8); envelope.signature.sig = s.toString('base64url'); break; }
          case 7: envelope.manifest.events = { count: Math.floor(rand() * 5), head_hash: envelope.manifest.events.head_hash }; break;
          case 8: envelope.manifest.events = { count: events.length, head_hash: 'f'.repeat(64) }; break;
          case 9: matchId = '99999999-8888-4777-8666-555555555555'; break;
          default: envelope.manifest.spec = 'arena-integrity/9';
        }
      }
      const ours = await verifyMatch(nodeProvider, matchId, events, envelope, keys);
      const theirs = reference.verifyMatch(matchId, events as any, envelope as any, keys as any);
      expect({ result: ours.result, code: (ours as any).code }).toEqual({ result: theirs.result, code: (theirs as any).code });
    }
  });
});

describe('helpers', () => {
  it('hex and base64url agree with Node\'s Buffer', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 255);
      expect(toHex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
      expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes));
      expect(Array.from(fromBase64Url(Buffer.from(bytes).toString('base64url'))!)).toEqual(Array.from(bytes));
    }
  });
  it('base64url rejects padding, standard-alphabet characters and impossible lengths', () => {
    for (const bad of ['AA==', 'a+b/', 'a', 'abcde', 'ab cd', '']) if (bad !== '') expect(fromBase64Url(bad)).toBeNull();
    expect(Array.from(fromBase64Url('')!)).toEqual([]);
  });
});

describe('purity: the library can run in a web page', () => {
  const pure = ['canonical.ts', 'spec.ts', 'verify.ts', 'verify-web.ts'];
  const source = (file: string) => fs.readFileSync(path.join(root, 'src', 'integrity', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(pure)('%s imports only other pure integrity modules', file => {
    const imports = [...source(file).matchAll(/(?:import|export)[^;]*?from\s+'([^']+)'/g)].map(m => m[1]);
    for (const spec of imports) expect(['./canonical', './spec', './verify']).toContain(spec);
  });

  it.each(pure)('%s uses no Node globals, no database and no server code', file => {
    const code = source(file);
    for (const banned of [/\bBuffer\b/, /\bprocess\./, /\brequire\(/, /\b__dirname\b/, /@prisma/, /\bprisma\b/, /from\s+'(crypto|fs|path|child_process|os|node:[^']+)'/]) {
      expect(code).not.toMatch(banned);
    }
  });

  it('the Node provider is the only verifier file that touches Node\'s crypto', () => {
    expect(source('verify-node.ts')).toMatch(/from 'crypto'/);
    expect(source('verify.ts')).not.toMatch(/from 'crypto'/);
  });
});
