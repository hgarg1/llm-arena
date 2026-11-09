/**
 * What a visitor is told about a match's verification (story m1-09), and how lists filter on it. Pure apart from the Prisma
 * filter types.
 *
 *  - in-progress  the match is still running or queued: there is nothing to verify yet
 *  - signed       the match has a signed manifest (used in lists, where re-verifying every row would be too costly)
 *  - verified     the full check passed on this request (match page): event chain, signature, moves digest
 *  - failed       the full check failed: something no longer matches what was signed
 *  - unverified   a finished match with no manifest, because it was played before signing existed or was never sealed.
 *                 This is not a failure and is never backfilled: signing it now would vouch for a record nobody witnessed.
 */
import type { Prisma } from '@prisma/client';

export type VerificationState = 'in-progress' | 'signed' | 'verified' | 'failed' | 'unverified';

export const FINAL_MATCH_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

/** The value of the `verification` filter in a list URL. Anything else means "no filter". */
export type VerificationFilter = 'signed' | 'unverified';
export const parseVerificationFilter = (value: unknown): VerificationFilter | undefined =>
  value === 'signed' || value === 'unverified' ? value : undefined;

/** Matches that have a signed manifest. This is the filter a leaderboard must apply to count verified matches only. */
export const signedMatchWhere: Prisma.MatchWhereInput = { manifest: { isNot: null } };
/** Finished matches without a manifest. */
export const unverifiedMatchWhere: Prisma.MatchWhereInput = { manifest: { is: null }, status: { in: [...FINAL_MATCH_STATUSES] } };

export const verificationWhere = (filter: VerificationFilter | undefined): Prisma.MatchWhereInput =>
  filter === 'signed' ? signedMatchWhere : filter === 'unverified' ? unverifiedMatchWhere : {};

/** The state a list shows for a row, from what the list already has. */
export const listVerificationState = (match: { status: string; manifest?: unknown | null }): VerificationState =>
  match.manifest ? 'signed' : (FINAL_MATCH_STATUSES as readonly string[]).includes(match.status) ? 'unverified' : 'in-progress';

/** Text for each state: one short label, and a sentence for a tooltip or an explanation. */
export const VERIFICATION_COPY: Record<VerificationState, { label: string; detail: string }> = {
  'in-progress': { label: 'In progress', detail: 'This match has not finished, so there is nothing to verify yet.' },
  signed: { label: 'Signed', detail: 'This match has a signed manifest. Open the match to verify it.' },
  verified: { label: 'Verified', detail: 'The event log, the moves and the signature were checked and match what we signed.' },
  failed: { label: 'Verification failed', detail: 'Something in this match no longer matches what was signed. Treat the replay as untrustworthy.' },
  unverified: { label: 'Unverified', detail: 'This match has no signed manifest, for example because it was played before matches were signed. That is not a failure, but it cannot be verified.' }
};
