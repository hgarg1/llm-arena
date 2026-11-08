import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type session from 'express-session';

export interface SessionStatusOptions {
  /** The same secret(s) express-session signs the cookie with. */
  secret: string | string[];
  store: session.Store;
  cookieName?: string;
  /** Current global session version; sessions created under another version were revoked ("force logout everyone"). */
  getSessionVersion: () => Promise<string>;
  now?: () => number;
}

const readCookie = (header: string | undefined, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
};

/** Verifies a `s:<sid>.<signature>` cookie the way express-session / cookie-signature does. Returns the session id or null. */
export const unsignSessionCookie = (cookie: string, secrets: string[]): string | null => {
  if (!cookie.startsWith('s:')) return null;
  const value = cookie.slice(2);
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const sid = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, ''));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return sid;
  }
  return null;
};

const loadSession = (store: session.Store, sid: string) =>
  new Promise<session.SessionData | null>((resolve, reject) => {
    store.get(sid, (err, sess) => (err ? reject(err) : resolve(sess ?? null)));
  });

/**
 * `GET /auth/session`: is the visitor's login still valid right now?
 *
 * Deliberately mounted *before* the session middleware and reading the store directly: express-session extends a
 * session on every request that passes through it, so polling through it would keep a session alive forever. This
 * endpoint is read-only: it never sets a cookie and never touches the session.
 *
 * Only an explicit `authenticated: false` means "signed out". Errors are reported as 503 so clients never mistake an
 * outage for an expired login.
 */
export const createSessionStatusHandler = (options: SessionStatusOptions) => {
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  const cookieName = options.cookieName ?? 'connect.sid';
  const now = options.now ?? Date.now;

  return async (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store, private', Vary: 'Cookie' });
    const respond = (authenticated: boolean, expiresAt: Date | null = null) =>
      res.json({ authenticated, expiresAt: authenticated && expiresAt ? expiresAt.toISOString() : null, serverTime: new Date(now()).toISOString() });

    try {
      const raw = readCookie(req.headers.cookie, cookieName);
      const sid = raw ? unsignSessionCookie(raw, secrets) : null;
      if (!sid) return respond(false);

      const sess = (await loadSession(options.store, sid)) as (session.SessionData & { userId?: string; sessionVersion?: string }) | null;
      if (!sess || typeof sess.userId !== 'string' || !sess.userId) return respond(false);

      const rawExpiry = sess.cookie?.expires as unknown as string | Date | undefined;
      const expiresAt = rawExpiry ? new Date(rawExpiry) : null;
      if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now()) return respond(false);

      // Same rule the app enforces on every request: a missing or different version means the login was revoked.
      const version = await options.getSessionVersion();
      if (!sess.sessionVersion || sess.sessionVersion !== version) return respond(false);

      return respond(true, expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null);
    } catch (error) {
      console.error('session status check failed:', error);
      return res.status(503).json({ error: 'unavailable' });
    }
  };
};
