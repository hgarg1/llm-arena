const prismaMock: any = { httpSession: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn() } };
jest.mock('../src/config/db', () => ({ prisma: prismaMock }));

import { PrismaSessionStore } from '../src/config/session-store';

const call = <T>(fn: (cb: (err?: unknown, r?: T) => void) => void) => new Promise<{ err?: unknown; result?: T }>(resolve => fn((err, result) => resolve({ err, result })));
const sessionWith = (expires?: Date) => ({ cookie: { originalMaxAge: 1000, expires, httpOnly: true, path: '/' }, userId: 'u1' }) as any;

beforeEach(() => {
  Object.values(prismaMock.httpSession).forEach((fn: any) => fn.mockReset().mockResolvedValue({ count: 0 }));
});

describe('PrismaSessionStore', () => {
  it('returns the stored session while it is valid', async () => {
    prismaMock.httpSession.findUnique.mockResolvedValue({ sid: 's1', sess: { userId: 'u1' }, expire: new Date(Date.now() + 60_000) });
    const { err, result } = await call<any>(cb => new PrismaSessionStore().get('s1', cb));
    expect(err).toBeNull();
    expect(result).toEqual({ userId: 'u1' });
  });

  it('treats a missing or expired session as no session, and removes an expired row', async () => {
    prismaMock.httpSession.findUnique.mockResolvedValue(null);
    expect((await call(cb => new PrismaSessionStore().get('nope', cb))).result).toBeNull();
    prismaMock.httpSession.findUnique.mockResolvedValue({ sid: 's2', sess: {}, expire: new Date(Date.now() - 1) });
    expect((await call(cb => new PrismaSessionStore().get('s2', cb))).result).toBeNull();
    expect(prismaMock.httpSession.deleteMany).toHaveBeenCalledWith({ where: { sid: 's2' } });
  });

  it('uses the cookie expiry when present, otherwise the default lifetime', async () => {
    const expires = new Date(Date.now() + 3_600_000);
    await call(cb => new PrismaSessionStore(86_400_000, () => 1).set('s1', sessionWith(expires), cb));
    expect(prismaMock.httpSession.upsert.mock.calls[0][0].create.expire.getTime()).toBe(expires.getTime());
    prismaMock.httpSession.upsert.mockClear();
    const before = Date.now();
    await call(cb => new PrismaSessionStore(86_400_000, () => 1).set('s2', sessionWith(undefined), cb));
    const used = prismaMock.httpSession.upsert.mock.calls[0][0].create.expire.getTime();
    expect(used).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(used).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it('stores plain JSON (dates in the cookie become strings)', async () => {
    await call(cb => new PrismaSessionStore(undefined, () => 1).set('s1', sessionWith(new Date('2030-01-01T00:00:00Z')), cb));
    const stored = prismaMock.httpSession.upsert.mock.calls[0][0].update.sess;
    expect(stored.cookie.expires).toBe('2030-01-01T00:00:00.000Z');
    expect(stored.userId).toBe('u1');
  });

  it('occasionally prunes expired sessions, and never on every write', async () => {
    await call(cb => new PrismaSessionStore(undefined, () => 0.01).set('s1', sessionWith(), cb));
    expect(prismaMock.httpSession.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.httpSession.deleteMany.mock.calls[0][0].where.expire.lt).toBeInstanceOf(Date);
    prismaMock.httpSession.deleteMany.mockClear();
    await call(cb => new PrismaSessionStore(undefined, () => 0.5).set('s1', sessionWith(), cb));
    expect(prismaMock.httpSession.deleteMany).not.toHaveBeenCalled();
  });

  it('destroys and touches by session id', async () => {
    await call(cb => new PrismaSessionStore().destroy('s1', cb));
    expect(prismaMock.httpSession.deleteMany).toHaveBeenCalledWith({ where: { sid: 's1' } });
    await call(cb => new PrismaSessionStore().touch('s1', sessionWith(new Date(Date.now() + 5000)), cb));
    expect(prismaMock.httpSession.updateMany.mock.calls[0][0].where).toEqual({ sid: 's1' });
  });

  it('reports database errors to express-session instead of swallowing them', async () => {
    const boom = new Error('db down');
    prismaMock.httpSession.findUnique.mockRejectedValue(boom);
    expect((await call(cb => new PrismaSessionStore().get('s1', cb))).err).toBe(boom);
    prismaMock.httpSession.upsert.mockRejectedValue(boom);
    expect((await call(cb => new PrismaSessionStore().set('s1', sessionWith(), cb))).err).toBe(boom);
    prismaMock.httpSession.deleteMany.mockRejectedValue(boom);
    expect((await call(cb => new PrismaSessionStore().destroy('s1', cb))).err).toBe(boom);
  });
});

describe('why a dead session store makes every page stall (negative control)', () => {
  // express-session writes all but the last byte of a response immediately and the last byte only after the session
  // has been saved. If the store never answers (e.g. an unreachable Redis), the page never completes.
  it('a store that never answers leaves the response exactly one byte short', async () => {
    const express = jest.requireActual('express');
    const expressSession = jest.requireActual('express-session');
    const http = jest.requireActual('http');
    class HangingStore extends expressSession.Store {
      get = (_sid: string, cb: (e: unknown, s?: unknown) => void) => cb(null, null);
      set = () => { /* never calls back, like a Redis that does not answer */ };
      destroy = (_sid: string, cb?: () => void) => cb?.();
    }
    const body = '<html>' + 'y'.repeat(5000) + '</html>\n';
    const app = express();
    app.use(expressSession({ secret: 's', resave: false, saveUninitialized: false, store: new HangingStore() }));
    app.get('/', (req: any, res: any) => { req.session.touched = true; res.send(body); });
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    try {
      const outcome = await new Promise<{ received: number; declared: number; stalled: boolean }>(resolve => {
        let received = 0;
        let declared = 0;
        const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1500 }, (res: any) => {
          declared = Number(res.headers['content-length']);
          res.on('data', (c: Buffer) => { received += c.length; });
          res.on('end', () => resolve({ received, declared, stalled: false }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ received, declared, stalled: true }); });
        req.on('error', () => resolve({ received, declared, stalled: true }));
      });
      expect(outcome.stalled).toBe(true);
      expect(outcome.declared - outcome.received).toBe(1);
    } finally {
      server.close();
    }
  });
});
