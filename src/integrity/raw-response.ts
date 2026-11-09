/**
 * The raw provider response stored with a move (story m1-08). The digest in the move's provenance covers the whole scrubbed
 * response, so the stored copy can be deleted later (retention) or cut at a size limit without breaking verification of
 * the signed manifest. Server-side only (uses Node's crypto).
 */
import { createHash } from 'crypto';
import { scrubSecrets } from './redact';

/** A response larger than this (UTF-8 bytes of its JSON text) is stored cut off, and marked truncated. */
export const MAX_RAW_BYTES = 64 * 1024;

export interface PreparedRaw {
  /** The text stored in MoveRawResponse.body: the scrubbed response as JSON, cut at MAX_RAW_BYTES if it was longer. */
  text: string;
  /** UTF-8 byte length of the FULL scrubbed response. */
  bytes: number;
  /** SHA-256 (hex) of the FULL scrubbed response text, before any truncation. */
  sha256: string;
  truncated: boolean;
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export const truncateUtf8 = (text: string, maxBytes: number): string => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // step back to the start of a character
  return buf.subarray(0, end).toString('utf8');
};

/**
 * Scrubs secrets out of a provider response, serialises it, and computes the digest the provenance will carry.
 * `secrets` are exact strings to mask (the adapter's API key). Returns null when there is no response to keep.
 */
export const prepareRawResponse = (raw: unknown, secrets: string[] = [], maxBytes = MAX_RAW_BYTES): PreparedRaw | null => {
  if (raw === undefined) return null;
  const full = JSON.stringify(scrubSecrets(raw, secrets)) ?? 'null';
  const bytes = Buffer.byteLength(full, 'utf8');
  return {
    text: bytes > maxBytes ? truncateUtf8(full, maxBytes) : full,
    bytes,
    sha256: createHash('sha256').update(full, 'utf8').digest('hex'),
    truncated: bytes > maxBytes
  };
};
