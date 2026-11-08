/**
 * Structured metric lines. On Vercel they land in the function logs (searchable, and forwardable through a
 * log drain); locally they are plain JSON on stdout. One line per event keeps this dependency-free.
 */
export type MetricFields = Record<string, string | number | boolean | null | undefined>;

export const logMetric = (name: string, fields: MetricFields = {}) => {
  try {
    console.log(JSON.stringify({ metric: name, ts: new Date().toISOString(), ...fields }));
  } catch {
    // metrics must never break a match
  }
};
