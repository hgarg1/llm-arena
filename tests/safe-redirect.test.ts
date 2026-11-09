import { sanitizeNextPath } from '../src/utils/safe-redirect';

describe('sanitizeNextPath (post-login return path)', () => {
  it.each([
    ['/', '/'],
    ['/chat', '/chat'],
    ['/chat/channels/7', '/chat/channels/7'],
    ['/matches/abc?replay=3&tab=elo', '/matches/abc?replay=3&tab=elo'],
    ['/benchmarks#top', '/benchmarks#top'],
    ['  /about  ', '/about'],
    ['/path/with%20encoded/chars', '/path/with%20encoded/chars'],
    ['/a/./b/../c', '/a/c']
  ])('keeps the same-site path %p', (input, expected) => {
    expect(sanitizeNextPath(input)).toBe(expected);
  });

  it.each([
    'https://evil.example/phish',
    'http://evil.example',
    '//evil.example/phish',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'evil.example/phish',
    'chat',
    '',
    '   ',
    '/ok\r\nSet-Cookie: x=1',
    '/ok\u0000',
    '/with\\backslash',
    '/..//evil.example', // dot segments normalise to //evil.example
    '/a/..//evil.example',
    '/././/evil.example'
  ])('rejects %p and falls back', input => {
    expect(sanitizeNextPath(input)).toBe('/');
  });

  it('keeps percent-encoded slashes as plain path text (they cannot change the host)', () => {
    expect(sanitizeNextPath('/%2f%2fevil.example')).toBe('/%2f%2fevil.example');
    expect(new URL(sanitizeNextPath('/%2f%2fevil.example'), 'https://site.test').origin).toBe('https://site.test');
  });

  it('rejects the auth pages so sign-in can never loop back into itself', () => {
    for (const p of ['/auth/login', '/auth/signup', '/auth', '/auth/login?next=/chat', '/auth/passkey/auth/verify']) expect(sanitizeNextPath(p)).toBe('/');
    expect(sanitizeNextPath('/authors')).toBe('/authors'); // only the /auth segment is blocked
  });

  it('rejects oversized values, non-strings and objects', () => {
    expect(sanitizeNextPath('/' + 'a'.repeat(600))).toBe('/');
    expect(sanitizeNextPath('/' + 'a'.repeat(300))).toBe('/' + 'a'.repeat(300));
    for (const bad of [undefined, null, 42, {}, [], ['/chat'], true]) expect(sanitizeNextPath(bad as any)).toBe('/');
  });

  it('uses the caller\'s fallback when given one', () => {
    expect(sanitizeNextPath('https://evil.example', '')).toBe('');
    expect(sanitizeNextPath(undefined, '/home')).toBe('/home');
    expect(sanitizeNextPath('/ok', '/home')).toBe('/ok');
  });

  it('the result is always a same-site absolute path', () => {
    const samples = ['/a', '/a?b=c', 'https://x.y', '//x.y', '/\\x.y', '/a/../../b', '/%5Cx.y', '/..//x.y', '/./\\x.y'];
    for (const s of samples) {
      const out = sanitizeNextPath(s);
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(new URL(out, 'https://site.test').origin).toBe('https://site.test');
    }
  });
});
