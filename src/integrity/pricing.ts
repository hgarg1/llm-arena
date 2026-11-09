/**
 * Turning token counts into a cost (story m1-08). The price list is configuration (src/config/model-pricing.json), never
 * guessed in code. The rates that were applied are recorded with every move, so a recorded cost can be recomputed from the
 * move alone, and a model without a price is recorded as `unknown` instead of as zero.
 */
import table from '../config/model-pricing.json';
import { UNKNOWN } from '../game/types';

export interface PriceEntry { provider: string; model_prefix: string; input_per_mtok: number; output_per_mtok: number }
export interface PriceTable { version: string | null; models: PriceEntry[] }
export const DEFAULT_PRICE_TABLE = table as unknown as PriceTable;

export interface TokenUsage { input_tokens: number | typeof UNKNOWN; output_tokens: number | typeof UNKNOWN; source: 'provider' | 'estimated' }

export interface Cost {
  usd: number | typeof UNKNOWN;
  /** Which token counts the cost was computed from. */
  basis: 'provider-usage' | 'estimated-usage' | typeof UNKNOWN;
  pricing: { input_per_mtok: number; output_per_mtok: number; table_version: string } | typeof UNKNOWN;
}

/** The entry for `provider` whose prefix matches the model id, preferring the longest prefix. */
export const findPrice = (prices: PriceTable, provider: string, ...modelIds: string[]): PriceEntry | null => {
  let best: PriceEntry | null = null;
  for (const entry of prices.models) {
    if (entry.provider !== provider) continue;
    if (!modelIds.some(id => id && id.startsWith(entry.model_prefix))) continue;
    if (!best || entry.model_prefix.length > best.model_prefix.length) best = entry;
  }
  return best;
};

export const computeCost = (prices: PriceTable, provider: string, requested: string, reported: string, usage: TokenUsage): Cost => {
  const entry = findPrice(prices, provider, reported, requested);
  const unknown: Cost = { usd: UNKNOWN, basis: UNKNOWN, pricing: UNKNOWN };
  if (!entry || !prices.version || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return unknown;
  const usd = (usage.input_tokens * entry.input_per_mtok + usage.output_tokens * entry.output_per_mtok) / 1_000_000;
  return {
    usd: Math.round(usd * 1e8) / 1e8,
    basis: usage.source === 'provider' ? 'provider-usage' : 'estimated-usage',
    pricing: { input_per_mtok: entry.input_per_mtok, output_per_mtok: entry.output_per_mtok, table_version: prices.version }
  };
};
