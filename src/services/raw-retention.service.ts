/**
 * Retention for raw provider responses (story m1-08). A stored response is deleted once it is older than the retention
 * window; the move's provenance keeps its digest, so the signed manifest still verifies and the response can be checked
 * against the digest by anyone who kept a copy. Matches are never touched, only MoveRawResponse rows.
 *
 * INTEGRITY_RAW_RETENTION_DAYS: days to keep raw responses (default 90). `0` keeps them forever.
 */
import { prisma } from '../config/db';

export const rawRetentionDays = (): number => {
  const value = process.env.INTEGRITY_RAW_RETENTION_DAYS;
  if (value === undefined || value === '') return 90;
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? days : 90;
};

const BATCH = 500;
const MAX_BATCHES = 10; // per sweep, so one run can never hold a long lock

export const purgeExpiredRawResponses = async (options: { now?: Date; days?: number } = {}): Promise<{ deleted: number }> => {
  const days = options.days ?? rawRetentionDays();
  if (days <= 0) return { deleted: 0 };
  const cutoff = new Date((options.now ?? new Date()).getTime() - days * 86_400_000);
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await prisma.moveRawResponse.findMany({ where: { created_at: { lt: cutoff } }, select: { match_id: true, move_index: true }, take: BATCH });
    if (batch.length === 0) break;
    const result = await prisma.moveRawResponse.deleteMany({ where: { OR: batch.map(b => ({ match_id: b.match_id, move_index: b.move_index })) } });
    deleted += result.count;
    if (batch.length < BATCH) break;
  }
  return { deleted };
};
