const findByEmail = jest.fn();
const compare = jest.fn();
jest.mock('bcrypt', () => ({ __esModule: true, default: { compare: (...a: any[]) => compare(...a), hash: jest.fn() } }));
jest.mock('../src/repositories/user.repository', () => ({ UserRepository: class { findByEmail = findByEmail; } }));
jest.mock('../src/config/db', () => ({ prisma: { user: { update: jest.fn() } } }));
jest.mock('../src/services/communication', () => ({ comms: {} }));
jest.mock('../src/services/webauthn.service', () => ({ webAuthnService: {} }));

import { login, loginPage } from '../src/controllers/auth.controller';

const session = () => {
  const s: any = { cookie: {} };
  s.regenerate = (cb: (e?: unknown) => void) => cb();
  s.save = (cb: (e?: unknown) => void) => cb();
  s.destroy = (cb: () => void) => cb();
  return s;
};
const run = async (fn: any, { query = {}, body = {} }: { query?: any; body?: any } = {}) => {
  const res: any = { locals: { settings: { session_idle_minutes: '60' } }, redirected: undefined as string | undefined, rendered: undefined as any };
  res.redirect = (u: string) => { res.redirected = u; };
  res.render = (view: string, data: any) => { res.rendered = { view, data }; };
  res.clearCookie = () => undefined;
  await fn({ query, body, session: session() } as any, res);
  return res;
};

beforeEach(() => {
  findByEmail.mockReset().mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'USER', tier: 'FREE', password_hash: 'hash', email_verified: true });
  compare.mockReset().mockResolvedValue(true);
});

describe('login returns the visitor to where they were', () => {
  it('the sign-in page carries a validated next path into the form', async () => {
    expect((await run(loginPage, { query: { next: '/chat/channels/7?x=1' } })).rendered.data.next).toBe('/chat/channels/7?x=1');
  });

  it('the sign-in page drops anything that is not a same-site path', async () => {
    for (const next of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/auth/login', undefined]) {
      expect((await run(loginPage, { query: { next } })).rendered.data.next).toBe('');
    }
  });

  it('a successful login redirects to the requested page', async () => {
    const res = await run(login, { body: { email: 'a@b.c', password: 'pw', next: '/matches/abc?replay=3' } });
    expect(res.redirected).toBe('/matches/abc?replay=3');
  });

  it('without a next path it still goes to the home page (behaviour unchanged)', async () => {
    expect((await run(login, { body: { email: 'a@b.c', password: 'pw' } })).redirected).toBe('/');
  });

  it('a hostile next path never becomes an open redirect', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/auth/login']) {
      expect((await run(login, { body: { email: 'a@b.c', password: 'pw', next } })).redirected).toBe('/');
    }
  });

  it('a failed login keeps the next path so the retry still returns to the right place', async () => {
    compare.mockResolvedValue(false);
    const res = await run(login, { body: { email: 'a@b.c', password: 'wrong', next: '/chat' } });
    expect(res.redirected).toBeUndefined();
    expect(res.rendered.data).toMatchObject({ error: 'Invalid credentials', next: '/chat' });
  });

  it('an unknown account also keeps the next path, and a hostile one is dropped', async () => {
    findByEmail.mockResolvedValue(null);
    expect((await run(login, { body: { email: 'x@y.z', password: 'pw', next: '/chat' } })).rendered.data.next).toBe('/chat');
    expect((await run(login, { body: { email: 'x@y.z', password: 'pw', next: '//evil.example' } })).rendered.data.next).toBe('');
  });
});
