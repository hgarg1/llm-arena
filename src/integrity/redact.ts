/**
 * Removing secrets from a provider response before it is stored or hashed (story m1-08: API keys and auth headers are
 * never stored). Pure. Two layers: values under key names that hold credentials are replaced, and any string that looks
 * like a credential, or contains a secret the caller knows about (the adapter's own API key), is masked.
 */
export const REDACTED = '[redacted]';

// Exact key names (case-insensitive, `-` and `_` ignored) that hold credentials. Deliberately not a substring match, so
// usage fields such as `prompt_tokens` are untouched.
const SECRET_KEYS = new Set([
  'authorization', 'proxyauthorization', 'xapikey', 'apikey', 'xgoogapikey', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer',
  'cookie', 'setcookie', 'secret', 'clientsecret', 'password', 'passwd', 'privatekey', 'xauthtoken', 'sessiontoken', 'secretaccesskey'
]);
const normalise = (key: string) => key.toLowerCase().replace(/[-_\s]/g, '');

// Strings that look like credentials, wherever they appear.
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,           // OpenAI / Anthropic style keys
  /\bAIza[0-9A-Za-z_-]{20,}/g,          // Google API keys
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bnpg_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g
];

const maskString = (text: string, secrets: string[]): string => {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(REDACTED);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
};

/**
 * Returns a deep copy of `value` with credentials removed. `secrets` are exact strings to mask wherever they occur (pass the
 * adapter's API key). The input is never modified. Non-JSON values (functions, symbols, undefined) are dropped as JSON would.
 */
export const scrubSecrets = (value: unknown, secrets: string[] = [], seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'string') return maskString(value, secrets);
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(v => scrubSecrets(v, secrets, seen) ?? null);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(normalise(key))) { out[key] = REDACTED; continue; }
    const scrubbed = scrubSecrets(v, secrets, seen);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
};
