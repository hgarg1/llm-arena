const MAX_LENGTH = 512;

/**
 * Validates a post-login return path. Only a same-site absolute *path* is accepted; anything that could send the
 * visitor to another origin (`//evil.com`, `/\evil.com`, `https://...`, `javascript:`), contains control characters, is
 * oversized, or points back into the auth pages (which would loop) falls back to `/`.
 */
export const sanitizeNextPath = (value: unknown, fallback = '/'): string => {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_LENGTH) return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate, 'http://same-site.invalid');
  } catch {
    return fallback;
  }
  if (parsed.origin !== 'http://same-site.invalid') return fallback;
  if (parsed.pathname === '/auth' || parsed.pathname.startsWith('/auth/')) return fallback;
  // Dot segments are resolved by the URL parser, so `/..//host` becomes `//host` (protocol-relative): re-check the result.
  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.startsWith('//')) return fallback;
  return normalized;
};
