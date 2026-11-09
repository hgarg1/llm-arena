/**
 * Retention for raw provider responses (story m1-08). A stored response is deleted once it is older than the retention
 * window; the move's provenance keeps its digest, so the signed manifest still verifies and the response can be checked
 * against the digest by anyone who kept a copy. Matches are never touched, only MoveRawResponse rows.
 *
 * The window is the admin setting `integrity_raw_retention_days` (default 90). `0` keeps responses forever. The public
 * policy page (/data-retention) reports the same value through the same parser, so what it says is what the sweeper does.
 */
import { prisma } from '../config/db';
import { settingsService } from './settings.service';

export const DEFAULT_RAW_RETENTION_DAYS = 90;
export const RAW_RETENTION_SETTING = 'integrity_raw_retention_days';

/** A whole number of days, 0 or more. Anything else (empty, negative, fractional, not a number) falls back to the default. */
export const parseRetentionDays = (value: unknown): number => {
  if (typeof value !== 'string' && typeof value !== 'number') return DEFAULT_RAW_RETENTION_DAYS;
  const text = String(value).trim();
  if (!/^\d{1,5}$/.test(text)) return DEFAULT_RAW_RETENTION_DAYS;
  return Number(text);
};

export const rawRetentionDays = async (): Promise<number> => parseRetentionDays((await settingsService.getAll())[RAW_RETENTION_SETTING]);

const BATCH = 500;
const MAX_BATCHES = 10; // per sweep, so one run can never hold a long lock

export const purgeExpiredRawResponses = async (options: { now?: Date; days?: number } = {}): Promise<{ deleted: number }> => {
  const days = options.days ?? (await rawRetentionDays());
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
