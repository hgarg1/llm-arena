/**
 * Sealing a finished match: sign its manifest and store it (docs/INTEGRITY_SPEC.md sections 5 to 7).
 *
 * `sealIfFinal` is level-triggered and idempotent, so it can be called from every place a match can end (the runner at
 * the end of a slice, the admin cancel handler, the sweeper's repair pass) without coordination. It signs only when
 *  - the match is in a final state (COMPLETED, FAILED or CANCELLED),
 *  - no runner holds a live lease (nobody can still be appending events),
 *  - the stored hash chain verifies (a log that no longer matches its own hashes is never signed),
 *  - and it has not been sealed already.
 * While a manifest exists the log is sealed: repositories refuse to append (see MatchRepository). Retrying a match
 * deletes the manifest (`clearManifest`), and the next final state signs a new one.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { createHash } from 'crypto';
import { canonicalize } from '../integrity/canonical';
import { engineIdentity } from '../integrity/engine-identity';
import { chain, genesisHash } from '../integrity/hash-chain';
import { moveChainHashes } from '../integrity/verify';
import { nodeProvider } from '../integrity/verify-node';
import { IntegrityConfigError, KeySet, PUBLISHED_KEYS } from '../integrity/keys';
import { FinalStatus, Signer, assertSignerPublished, buildManifest, signManifest, signerFromSeed } from '../integrity/signing';

export const FINAL_STATUSES: FinalStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Settings larger than this (canonical JSON) are represented by their hash only. */
const MAX_OPTIONS_CHARS = 16_384;

export type SealResult =
  | { status: 'signed'; keyId: string }
  | { status: 'skipped'; reason: string; code: 'NO_KEY' | 'NOT_FOUND' | 'NOT_FINAL' | 'LEASE_ACTIVE' | 'ALREADY_SEALED' | 'UNCHAINED' | 'CHAIN_BROKEN' | 'MOVES_BROKEN' | 'KEY_NOT_PUBLISHED' };

interface TestConfig { signer?: Signer | null; keys?: KeySet }
let override: TestConfig | null = null;
let envCache: { raw: string; signer: Signer } | null = null;

/** Tests inject a signer and key set; `null` restores the real configuration (environment key, published key set). */
export const configureIntegrityForTests = (config: TestConfig | null) => {
  override = config;
  envCache = null;
};

const log = (level: 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) =>
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ at: 'integrity', level, message, ...fields }));

const currentSigner = (): Signer | null => {
  if (override && 'signer' in override) return override.signer ?? null;
  const raw = process.env.INTEGRITY_SIGNING_KEY;
  if (!raw) return null;
  if (envCache?.raw === raw) return envCache.signer;
  const signer = signerFromSeed(raw); // throws IntegrityConfigError for a malformed key
  envCache = { raw, signer };
  return signer;
};

const skipped = (code: Extract<SealResult, { status: 'skipped' }>['code'], reason: string): SealResult => ({ status: 'skipped', code, reason });

export const sealIfFinal = async (matchId: string, options: { now?: Date } = {}): Promise<SealResult> => {
  let signer: Signer | null;
  try {
    signer = currentSigner();
    if (signer) assertSignerPublished(signer, override?.keys ?? PUBLISHED_KEYS);
  } catch (err) {
    if (!(err instanceof IntegrityConfigError)) throw err;
    log('error', 'match cannot be sealed: signing is misconfigured', { matchId, reason: err.message });
    return skipped('KEY_NOT_PUBLISHED', err.message);
  }
  if (!signer) return skipped('NO_KEY', 'no signing key is configured (INTEGRITY_SIGNING_KEY)');
  const now = options.now ?? new Date();

  // Most calls come from a runner whose slice merely yielded: one cheap read, no transaction, nothing else.
  const peek = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true } });
  if (peek && !FINAL_STATUSES.includes(peek.status as FinalStatus)) return skipped('NOT_FINAL', `match is ${peek.status}`);

  return prisma.$transaction(async tx => {
    // Retrying or resuming a match updates this same row, so the two cannot interleave with sealing.
    await tx.$queryRaw`SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`;
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: { id: true, game_type: true, ruleset_version: true, seed: true, options: true, engine_artifact_id: true, status: true, started_at: true, finished_at: true, lease_owner: true, lease_expires_at: true, manifest: { select: { match_id: true } } }
    });
    if (!match) return skipped('NOT_FOUND', 'match not found');
    if (!FINAL_STATUSES.includes(match.status as FinalStatus)) return skipped('NOT_FINAL', `match is ${match.status}`);
    if (match.manifest) return skipped('ALREADY_SEALED', 'a manifest already exists');
    if (match.lease_owner && match.lease_expires_at && match.lease_expires_at > now) return skipped('LEASE_ACTIVE', 'a runner still holds the lease');

    const rows = await tx.matchEvent.findMany({
      where: { match_id: matchId },
      orderBy: { seq: 'asc' },
      select: { seq: true, turn_index: true, type: true, actor_role: true, payload: true, hash: true, prev_hash: true }
    });
    if (rows.some(r => r.hash === null || r.prev_hash === null)) {
      return skipped('UNCHAINED', 'the match began before hash chaining existed; it stays Unverified');
    }

    // Never sign a log that does not match its own hashes: that would vouch for tampered or corrupted data.
    const recomputed = chain(matchId, rows.map(r => ({ seq: r.seq, turn_index: r.turn_index, type: r.type, actor_role: r.actor_role, payload: r.payload })));
    const consistent = rows.every((r, i) => r.seq === i && r.hash === recomputed.hashes[i] && r.prev_hash === (i === 0 ? genesisHash(matchId) : rows[i - 1].hash));
    if (!consistent) {
      log('error', 'stored event chain does not verify; refusing to sign', { matchId });
      return skipped('CHAIN_BROKEN', 'the stored hash chain does not verify');
    }

    // The moves and their provenance: one digest in the manifest, so editing a stored move or its provenance later is detectable.
    const moveRows = await tx.matchMove.findMany({ where: { match_id: matchId }, orderBy: { move_index: 'asc' }, select: { move_index: true, actor_role: true, content: true, provenance: true } });
    if (!moveRows.every((m, i) => m.move_index === i)) {
      log('error', 'stored moves have a gap; refusing to sign', { matchId });
      return skipped('MOVES_BROKEN', 'the stored moves are not numbered 0..n-1');
    }
    const movesDigest = moveRows.length > 0
      ? { count: moveRows.length, headHash: (await moveChainHashes(nodeProvider, matchId, moveRows.map(m => ({ move_index: m.move_index, actor_role: m.actor_role, content: m.content, provenance: m.provenance })))).head }
      : undefined;

    // Which code ran, and with which settings (spec section 5). Missing information is left out, never guessed.
    const artifact = match.engine_artifact_id
      ? await tx.gameEngineArtifact.findUnique({ where: { id: match.engine_artifact_id }, select: { id: true, kind: true, native_key: true, code_ts: true, contract_version: true } })
      : null;
    const engine = engineIdentity(match.game_type, artifact);
    if (!engine) log('warn', 'engine identity could not be established; the manifest will not name it', { matchId, gameType: match.game_type });
    let optionsMembers: { options?: unknown; optionsSha256?: string } = {};
    try {
      const text = canonicalize(match.options ?? {});
      optionsMembers = { optionsSha256: createHash('sha256').update(text, 'utf8').digest('hex'), ...(text.length <= MAX_OPTIONS_CHARS ? { options: match.options ?? {} } : {}) };
    } catch (err) {
      log('warn', 'match options cannot be canonicalized; the manifest will not record them', { matchId, reason: (err as Error).message });
    }

    const manifest = buildManifest({
      matchId, keyId: signer!.keyId, gameType: match.game_type, rulesetVersion: match.ruleset_version, seed: match.seed,
      status: match.status as FinalStatus, eventCount: rows.length, headHash: recomputed.head,
      startedAt: match.started_at, finishedAt: match.finished_at, engine, moves: movesDigest, ...optionsMembers
    });
    const envelope = await signManifest(manifest, signer!);
    await tx.matchManifest.create({
      data: { match_id: matchId, key_id: signer!.keyId, manifest: envelope.manifest as unknown as Prisma.InputJsonValue, signature: envelope.signature.sig }
    });
    return { status: 'signed' as const, keyId: signer!.keyId };
  }, { timeout: 20_000, maxWait: 10_000 });
};

/** Removes the manifest because the match is no longer final (it was retried or resumed). */
export const clearManifest = async (matchId: string): Promise<void> => {
  await prisma.matchManifest.deleteMany({ where: { match_id: matchId } });
};

/**
 * Repair pass: seals recent final matches that have no manifest (a runner died before sealing, a cancel raced with a
 * live runner, signing was misconfigured for a while). Old matches are not scanned, and matches from before hash chaining
 * began are never candidates: they either have events without hashes, or were created before the first chained event.
 * Nothing is ever signed retroactively (docs/INTEGRITY_SPEC.md section 7).
 */
export const sealUnsealed = async (options: { limit?: number; lookbackHours?: number; now?: Date } = {}) => {
  let configured = false;
  try { configured = Boolean(currentSigner()); } catch { configured = true; /* misconfigured: sealIfFinal reports it */ }
  if (!configured) return { scanned: 0, counts: {} as Record<string, number> }; // signing is off: no database work
  const now = options.now ?? new Date();
  const lookback = new Date(now.getTime() - (options.lookbackHours ?? Number(process.env.INTEGRITY_SEAL_LOOKBACK_HOURS || 72)) * 3_600_000);
  // Never backfill: only matches created since hash chaining began in this database can be repaired. Without this, a match from
  // before chaining that finished with no events (for example "could not start") would be signed after the fact, vouching for a
  // record nobody witnessed. The first chained event marks the start of the chain era; with none yet there is nothing to repair.
  const firstChained = await prisma.matchEvent.findFirst({ where: { hash: { not: null } }, orderBy: { created_at: 'asc' }, select: { created_at: true } });
  if (!firstChained) return { scanned: 0, counts: {} as Record<string, number> };
  const since = firstChained.created_at > lookback ? firstChained.created_at : lookback;
  const candidates = await prisma.match.findMany({
    where: {
      status: { in: FINAL_STATUSES },
      manifest: null,
      created_at: { gte: since },
      OR: [{ events: { none: {} } }, { events: { some: { hash: { not: null } } } }]
    },
    orderBy: { created_at: 'asc' },
    take: options.limit ?? 50,
    select: { id: true }
  });
  const counts: Record<string, number> = {};
  for (const { id } of candidates) {
    const result = await sealIfFinal(id, { now });
    const key = result.status === 'signed' ? 'signed' : result.code;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { scanned: candidates.length, counts };
};
