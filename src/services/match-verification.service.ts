/**
 * Verifies one stored match with the real verifier (src/integrity/verify.ts) against the published key set, for the match page.
 * Read-only: it never signs anything and never writes.
 */
import { prisma } from '../config/db';
import { PUBLISHED_KEYS, KeySet } from '../integrity/keys';
import { FINAL_MATCH_STATUSES, VerificationState } from '../integrity/status';
import { verifyMatch } from '../integrity/verify';
import { nodeProvider } from '../integrity/verify-node';

export interface StoredMatchVerification {
  state: VerificationState;
  /** The verifier's failure code when state is `failed` (or ERROR code when the check could not run). */
  code?: string;
}

export const verifyStoredMatch = async (matchId: string, keys: KeySet = PUBLISHED_KEYS): Promise<StoredMatchVerification> => {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: { status: true, manifest: true } });
  if (!match) return { state: 'unverified' };
  if (!match.manifest) {
    return { state: (FINAL_MATCH_STATUSES as readonly string[]).includes(match.status) ? 'unverified' : 'in-progress' };
  }

  const [events, moves] = await Promise.all([
    prisma.matchEvent.findMany({ where: { match_id: matchId }, orderBy: { seq: 'asc' }, select: { seq: true, turn_index: true, type: true, actor_role: true, payload: true } }),
    prisma.matchMove.findMany({ where: { match_id: matchId }, orderBy: { move_index: 'asc' }, select: { move_index: true, actor_role: true, content: true, provenance: true } })
  ]);
  const outcome = await verifyMatch(
    nodeProvider, matchId, events,
    { manifest: match.manifest.manifest as any, signature: { alg: 'Ed25519', key_id: match.manifest.key_id, sig: match.manifest.signature } },
    keys.keys, { moves }
  );
  if (outcome.result === 'VERIFIED') return { state: 'verified' };
  if (outcome.result === 'FAILED') return { state: 'failed', code: outcome.code };
  // The check could not run (ERROR) or there is no manifest (UNVERIFIED): never present either as a pass.
  return { state: outcome.result === 'UNVERIFIED' ? 'unverified' : 'failed', code: outcome.result === 'ERROR' ? outcome.code : undefined };
};
