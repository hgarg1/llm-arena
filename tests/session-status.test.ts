import { createHmac } from 'crypto';
import express from 'express';
import session from 'express-session';
import type { AddressInfo } from 'net';
import { createSessionStatusHandler, unsignSessionCookie } from '../src/middleware/session-status';

const SECRET = 'test-secret';
const sign = (sid: string, secret = SECRET) => `s:${sid}.${createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;

describe('unsignSessionCookie', () => {
  it('accepts a cookie signed with any configured secret', () => {
    expect(unsignSessionCookie(sign('abc'), [SECRET])).toBe('abc');
    expect(unsignSessionCookie(sign('abc', 'old'), ['new', 'old'])).toBe('abc');
  });
  it('rejects forged, unsigned, truncated and malformed cookies', () => {
    expect(unsignSessionCookie(sign('abc', 'other'), [SECRET])).toBeNull();
    expect(unsignSessionCookie('abc.def', [SECRET])).toBeNull();
    expect(unsignSessionCookie('s:abc', [SECRET])).toBeNull();
    expect(unsignSessionCookie('s:.sig', [SECRET])).toBeNull();
    expect(unsignSessionCookie(sign('abc').slice(0, -3), [SECRET])).toBeNull();
    expect(unsignSessionCookie(sign('abc') + 'x', [SECRET])).toBeNull();
    expect(unsignSessionCookie(sign('abc').replace('abc', 'abd'), [SECRET])).toBeNull();
  });
});

type Harness = { base: string; store: session.MemoryStore; setVersion: (v: string) => void; setNow: (ms: number) => void; versionCalls: () => number; close: () => Promise<void>; failStore: (on: boolean) => void };

const start = async (opts: { maxAge?: number } = {}): Promise<Harness> => {
  const store = new session.MemoryStore();
  let version = '1';
  let versionCalls = 0;
  let clock: number | null = null;
  let broken = false;
  const realGet = store.get.bind(store);
  store.get = ((sid: string, cb: any) => (broken ? cb(new Error('store down')) : realGet(sid, cb))) as any;

  const app = express();
  // Same ordering as src/app.ts: status endpoint first, then the session middleware.
  app.get('/auth/session', createSessionStatusHandler({
    secret: SECRET, store, now: () => clock ?? Date.now(),
    getSessionVersion: async () => { versionCalls++; return version; }
  }));
  app.use(session({ secret: SECRET, store, resave: false, saveUninitialized: false, rolling: true, cookie: { maxAge: opts.maxAge ?? 60_000 } }));
  app.get('/login', (req, res) => { (req.session as any).userId = 'u1'; (req.session as any).sessionVersion = req.query.v ?? version; res.send('ok'); });
  app.get('/anon', (req, res) => { (req.session as any).visited = true; res.send('ok'); });
  app.get('/page', (_req, res) => res.send('page'));

  const server = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store,
    setVersion: v => { version = v; }, setNow: ms => { clock = ms; }, versionCalls: () => versionCalls, failStore: on => { broken = on; },
    close: () => new Promise(r => server.close(() => r()))
  };
};

const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0];
const poll = (h: Harness, cookie?: string) => fetch(`${h.base}/auth/session`, { headers: cookie ? { cookie } : {} });

describe('GET /auth/session', () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it('reports a live login with its expiry and the server clock', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    const res = await poll(h, cookie);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(Math.abs(new Date(body.serverTime).getTime() - Date.now())).toBeLessThan(5000);
  });

  it('is never cached and never sets a cookie', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    for (const c of [cookie, undefined]) {
      const res = await poll(h, c);
      expect(res.headers.get('cache-control')).toBe('no-store, private');
      expect(res.headers.get('vary')).toMatch(/Cookie/i);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('says signed out for visitors with no cookie, a forged cookie, or an unknown session', async () => {
    h = await start();
    expect(((await (await poll(h)).json()) as any).authenticated).toBe(false);
    expect(((await (await poll(h, `connect.sid=${encodeURIComponent(sign('nope', 'wrong'))}`)).json()) as any).authenticated).toBe(false);
    expect(((await (await poll(h, `connect.sid=${encodeURIComponent(sign('unknown'))}`)).json()) as any).authenticated).toBe(false);
    expect(((await (await poll(h, 'connect.sid=garbage%')).json()) as any).authenticated).toBe(false);
  });

  it('says signed out for an anonymous session that has no user', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/anon`));
    expect(cookie).toContain('connect.sid');
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(false);
  });

  it('says signed out once the session is destroyed server-side (logout elsewhere)', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
    await new Promise<void>(r => h.store.destroy(sid, () => r()));
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(false);
  });

  it('says signed out after the idle expiry passes, even if the store still holds the row', async () => {
    h = await start({ maxAge: 60_000 });
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    h.setNow(Date.now() + 61_000);
    const body: any = await (await poll(h, cookie)).json();
    expect(body.authenticated).toBe(false);
    expect(body.expiresAt).toBeNull();
  });

  it('says signed out when an admin forced everyone to sign out (session version changed)', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(true);
    h.setVersion('2');
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(false);
  });

  it('treats a session with no version as revoked', async () => {
    h = await start();
    const res = await fetch(`${h.base}/login?v=`);
    const cookie = cookieOf(res);
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(false);
  });

  it('polling does not extend the session, but a normal request does', async () => {
    h = await start({ maxAge: 60_000 });
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    const first: any = await (await poll(h, cookie)).json();
    await new Promise(r => setTimeout(r, 1100));
    for (let i = 0; i < 3; i++) await poll(h, cookie);
    const afterPolls: any = await (await poll(h, cookie)).json();
    expect(afterPolls.expiresAt).toBe(first.expiresAt);

    await fetch(`${h.base}/page`, { headers: { cookie } });
    const afterRealRequest: any = await (await poll(h, cookie)).json();
    expect(new Date(afterRealRequest.expiresAt).getTime()).toBeGreaterThan(new Date(first.expiresAt).getTime());
  });

  it('reports an outage as 503, never as signed out', async () => {
    h = await start();
    const cookie = cookieOf(await fetch(`${h.base}/login`));
    h.failStore(true);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await poll(h, cookie);
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    h.failStore(false);
    expect(((await (await poll(h, cookie)).json()) as any).authenticated).toBe(true);
  });

  it('does not look up the global version for visitors who are anyway signed out', async () => {
    h = await start();
    await poll(h);
    await poll(h, `connect.sid=${encodeURIComponent(sign('unknown'))}`);
    expect(h.versionCalls()).toBe(0);
  });
});
