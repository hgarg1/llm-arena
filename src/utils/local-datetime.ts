/**
 * Interprets an HTML `datetime-local` value ("2026-05-01T09:30") in the *browser's* timezone.
 * `tzOffsetMinutes` is `new Date().getTimezoneOffset()` from the browser (minutes behind UTC, so UTC+2 is -120).
 * Without an offset the value is interpreted in the server's timezone (previous behaviour).
 */
export const parseLocalDateTime = (value: unknown, tzOffsetMinutes?: unknown): Date | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  const offset = typeof tzOffsetMinutes === 'string' || typeof tzOffsetMinutes === 'number' ? Number(tzOffsetMinutes) : NaN;
  if (!match || !Number.isFinite(offset) || Math.abs(offset) > 14 * 60) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, y, mo, d, h, mi, sec] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec || 0));
  const date = new Date(asUtc + offset * 60_000);
  // Reject impossible dates such as 2026-02-31 that Date.UTC silently rolls over.
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null;
  return date;
};
