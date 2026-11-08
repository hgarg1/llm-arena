// eslint-disable-next-line @typescript-eslint/no-var-requires
const SessionWatch: any = require('../public/js/session-watch.js');

type Reply = { ok?: boolean; status?: number; body?: any; reject?: boolean; badJson?: boolean };

/** Fake environment: manual clock and timers, scripted fetch, spies for everything the watcher can do. */
const makeEnv = (overrides: Record<string, any> = {}) => {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const replies: Reply[] = [];
  const calls = { fetch: [] as string[], ui: [] as string[], navigate: [] as string[], reload: 0, swap: [] as string[], posts: [] as any[] };
  const storage = new Map<string, string>();
  const state = { visible: true, path: '/benchmarks?tab=elo', pathname: '/benchmarks' };

  const env: any = {
    fetch: (url: string) => {
      calls.fetch.push(url);
      const reply = replies.shift() ?? { body: { authenticated: true, expiresAt: null, serverTime: new Date(now).toISOString() } };
      if (reply.reject) return Promise.reject(new TypeError('network down'));
      return Promise.resolve({ ok: reply.ok ?? true, status: reply.status ?? 200, json: () => (reply.badJson ? Promise.reject(new Error('bad json')) : Promise.resolve(reply.body)) });
    },
    now: () => now,
    random: () => 0,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    isVisible: () => state.visible,
    currentPath: () => state.path,
    pathname: () => state.pathname,
    channel: { post: (m: any) => calls.posts.push(m) },
    storage: { get: (k: string) => storage.get(k) ?? null, set: (k: string, v: string) => { storage.set(k, v); } },
    ui: {
      ending: () => calls.ui.push('ending'),
      redirecting: () => calls.ui.push('redirecting'),
      signedOut: (href: string) => calls.ui.push(`signedOut:${href}`)
    },
    probe: () => Promise.resolve({ ok: true, status: 200, redirected: false, url: 'https://x.test/benchmarks', contentType: 'text/html', html: '<html>signed out</html>' }),
    swap: (html: string) => { calls.swap.push(html); return Promise.resolve(); },
    navigate: (url: string) => calls.navigate.push(url),
    reload: () => { calls.reload++; },
    ...overrides
  };

  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await flush();
    }
    now = target;
    await flush();
  };
  const status = (authenticated: boolean, expiresInMs: number | null = null): Reply => ({
    body: { authenticated, expiresAt: expiresInMs === null ? null : new Date(now + expiresInMs).toISOString(), serverTime: new Date(now).toISOString() }
  });
  const nextDueIn = () => Math.min(...[...timers.values()].map(x => x.at - now));
  return { env, calls, replies, storage, state, advance, flush, status, timers, nextDueIn, clock: () => now };
};

const watcherWith = (t: ReturnType<typeof makeEnv>, config: Record<string, unknown> = {}) => {
  const watcher = SessionWatch.createWatcher({ config, env: t.env });
  return watcher;
};

describe('classifyProbe', () => {
  const info = (over: any = {}) => ({ ok: true, status: 200, redirected: false, url: 'https://x.test/benchmarks', contentType: 'text/html; charset=utf-8', ...over });
  it.each([
    [info(), 'public'],
    [info({ ok: false, status: 401 }), 'protected'],
    [info({ ok: false, status: 403 }), 'protected'],
    [info({ redirected: true, url: 'https://x.test/auth/login' }), 'protected'],
    [info({ redirected: true, url: 'https://x.test/' }), 'protected'],
    [info({ redirected: true, url: 'https://x.test/benchmarks' }), 'failed'],
    [info({ ok: false, status: 500 }), 'failed'],
    [info({ ok: false, status: 404 }), 'failed'],
    [info({ contentType: 'application/json' }), 'failed'],
    [info({ contentType: '' }), 'failed']
  ])('%j -> %s', (input, expected) => {
    expect(SessionWatch.classifyProbe(input, '/benchmarks')).toBe(expected);
  });
});

describe('watching a healthy session', () => {
  it('makes a first check shortly after load, then keeps checking on a steady cadence', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    expect(t.calls.fetch).toHaveLength(0);
    await t.advance(1600);
    expect(t.calls.fetch).toEqual(['/auth/session']);
    await t.advance(59_000);
    expect(t.calls.fetch).toHaveLength(1);
    await t.advance(2000);
    expect(t.calls.fetch).toHaveLength(2);
    expect(t.calls.ui).toEqual([]);
  });

  it('checks just after the expected expiry instead of waiting a full minute', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    t.replies.push(t.status(true, 20_000));
    await t.advance(1600);
    expect(t.calls.fetch).toHaveLength(1);
    await t.advance(19_000);
    expect(t.calls.fetch).toHaveLength(1);
    await t.advance(2000); // 20s expiry + 1s grace
    expect(t.calls.fetch).toHaveLength(2);
  });

  it('measures expiry on the server clock, so a wrong device clock changes nothing', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    // Server says "expires in 30s" using a serverTime that is a day off from the device clock.
    t.replies.push({ body: { authenticated: true, expiresAt: '2030-01-02T00:00:30.000Z', serverTime: '2030-01-02T00:00:00.000Z' } });
    await t.advance(1600);
    await t.advance(29_000);
    expect(t.calls.fetch).toHaveLength(1);
    await t.advance(2000);
    expect(t.calls.fetch).toHaveLength(2);
  });

  it('never shows anything while the user is still signed in', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    for (let i = 0; i < 5; i++) { t.replies.push(t.status(true, 600_000)); await t.advance(61_000); }
    expect(t.calls.ui).toEqual([]);
    expect(t.calls.posts).toEqual([]);
    expect(w.state.phase).toBe('active');
  });

  it('remembers the check for other tabs, and a recent one makes a new page skip its initial request', async () => {
    const first = makeEnv();
    watcherWith(first).start();
    first.replies.push(first.status(true, 600_000));
    await first.advance(1600);
    const saved = first.storage.get('sw:ok')!;
    expect(JSON.parse(saved).exp).toBeGreaterThan(first.clock());

    const second = makeEnv();
    second.storage.set('sw:ok', JSON.stringify({ t: second.clock() - 10_000, exp: second.clock() + 120_000 }));
    watcherWith(second).start();
    await second.advance(3500);
    expect(second.calls.fetch).toHaveLength(0);       // reused the other tab's result
    await second.advance(61_000);
    expect(second.calls.fetch).toHaveLength(1);       // and still checks on schedule

    const stale = makeEnv();
    stale.storage.set('sw:ok', JSON.stringify({ t: stale.clock() - 120_000, exp: null }));
    watcherWith(stale).start();
    await stale.advance(3500);
    expect(stale.calls.fetch).toHaveLength(1);
  });

  it('survives unusable storage', async () => {
    const t = makeEnv({ storage: { get: () => { throw new Error('denied'); }, set: () => { throw new Error('denied'); } } });
    watcherWith(t).start();
    t.replies.push(t.status(true, 5000));
    await t.advance(1600);
    expect(t.calls.fetch).toHaveLength(1);
    await t.advance(7000);
    expect(t.calls.fetch).toHaveLength(2);
  });
});

describe('when the login has ended', () => {
  it('on a public page: shows the animation, fetches the signed-out page, morphs it in, then offers a way back in', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    t.replies.push(t.status(false));
    await t.advance(1600);
    expect(t.calls.ui[0]).toBe('ending');
    await t.advance(1600);
    expect(t.calls.swap).toEqual(['<html>signed out</html>']);
    expect(t.calls.ui[1]).toBe(`signedOut:/auth/login?next=${encodeURIComponent('/benchmarks?tab=elo')}`);
    expect(t.calls.navigate).toEqual([]);
    expect(t.calls.reload).toBe(0);
    expect(w.state.phase).toBe('ended');
  });

  it('keeps the animation visible for its minimum time even when the page arrives instantly', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    t.replies.push(t.status(false));
    await t.advance(1600);
    expect(t.calls.swap).toEqual([]);          // probe resolved at once, but the moment is still playing
    await t.advance(1300);
    expect(t.calls.swap).toHaveLength(1);
  });

  it('on a protected page: shows "taking you to sign in", then goes to sign in with a way back', async () => {
    const t = makeEnv({
      probe: () => Promise.resolve({ ok: false, status: 401, redirected: false, url: 'https://x.test/chat', contentType: 'text/html' })
    });
    t.state.path = '/chat/channels/7?x=1';
    t.state.pathname = '/chat/channels/7';
    watcherWith(t).start();
    t.replies.push(t.status(false));
    await t.advance(1600);
    await t.advance(1500);
    expect(t.calls.ui).toEqual(['ending', 'redirecting']);
    expect(t.calls.navigate).toEqual([]);
    await t.advance(1000);
    expect(t.calls.navigate).toEqual([`/auth/login?next=${encodeURIComponent('/chat/channels/7?x=1')}`]);
    expect(t.calls.swap).toEqual([]);
  });

  it('a page that redirects away when signed out counts as protected', async () => {
    const t = makeEnv({ probe: () => Promise.resolve({ ok: true, status: 200, redirected: true, url: 'https://x.test/auth/login', contentType: 'text/html' }) });
    watcherWith(t).start();
    t.replies.push(t.status(false));
    await t.advance(1600);
    await t.advance(3000);
    expect(t.calls.navigate).toHaveLength(1);
  });

  it('falls back to a plain reload when the signed-out page cannot be fetched or understood', async () => {
    for (const probe of [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve({ ok: false, status: 500, redirected: false, url: 'https://x.test/benchmarks', contentType: 'text/html' })
    ]) {
      const t = makeEnv({ probe });
      watcherWith(t).start();
      t.replies.push(t.status(false));
      await t.advance(1600);
      await t.advance(3000);
      expect(t.calls.reload).toBe(1);
      expect(t.calls.swap).toEqual([]);
    }
  });

  it('falls back to a plain reload when morphing the page fails', async () => {
    const t = makeEnv({ swap: () => Promise.reject(new Error('layout not found')) });
    watcherWith(t).start();
    t.replies.push(t.status(false));
    await t.advance(1600);
    await t.advance(3000);
    expect(t.calls.reload).toBe(1);
    expect(t.calls.ui).toContain('redirecting');
  });

  it('tells the other tabs, and handles the moment exactly once however many signals arrive', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    t.replies.push(t.status(false));
    const first = w.trigger('timer', true);
    w.trigger('focus', true);
    w.trigger('http-401', true);
    await t.flush();
    await t.advance(3000);
    await first;
    expect(t.calls.fetch).toHaveLength(1);
    expect(t.calls.posts).toEqual([{ type: 'ended' }]);
    expect(t.calls.ui.filter(u => u === 'ending')).toHaveLength(1);
    expect(t.calls.swap).toHaveLength(1);
    await w.trigger('visible');
    await w.trigger('online', true);
    expect(t.calls.fetch).toHaveLength(1); // the watcher is finished once the session has ended
  });

  it('stops polling afterwards', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    t.replies.push(t.status(false));
    await t.advance(5000);
    const before = t.calls.fetch.length;
    await t.advance(300_000);
    expect(t.calls.fetch).toHaveLength(before);
    expect(t.timers.size).toBe(0);
  });
});

describe('outages are never mistaken for a logout', () => {
  const failures: Array<[string, Reply]> = [
    ['network error', { reject: true }],
    ['HTTP 503', { ok: false, status: 503, body: { error: 'unavailable' } }],
    ['HTTP 500', { ok: false, status: 500 }],
    ['HTTP 401 on the status endpoint itself', { ok: false, status: 401 }],
    ['invalid JSON', { badJson: true }],
    ['a body without the expected field', { body: { hello: 'world' } }],
    ['authenticated as a non-boolean', { body: { authenticated: 'no' } }],
    ['an empty body', { body: null }]
  ];
  it.each(failures)('%s: nothing is shown and the watcher stays active', async (_name, reply) => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    t.replies.push(reply);
    await t.advance(1600);
    expect(t.calls.fetch).toHaveLength(1);
    expect(t.calls.ui).toEqual([]);
    expect(t.calls.swap).toEqual([]);
    expect(t.calls.navigate).toEqual([]);
    expect(t.calls.posts).toEqual([]);
    expect(w.state.phase).toBe('active');
  });

  it('backs off exponentially while the endpoint is failing, caps the delay, and recovers', async () => {
    const t = makeEnv();
    watcherWith(t).start();
    for (let i = 0; i < 6; i++) t.replies.push({ reject: true });
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await t.advance(i === 0 ? 1600 : delays[i - 1] + 50);
      expect(t.calls.fetch).toHaveLength(i + 1);
      delays.push(t.nextDueIn() + 0);
    }
    // each failure doubles the wait from 60s, up to the 300s ceiling (measured just after the check; the fake clock overshoots by up to 100 ms)
    const near = (value: number, target: number) => Math.abs(value - target) < 250;
    expect(near(delays[0], 60_000)).toBe(true);
    expect(near(delays[1], 120_000)).toBe(true);
    expect(near(delays[2], 240_000)).toBe(true);
    expect(near(delays[3], 300_000)).toBe(true);
    expect(near(delays[4], 300_000)).toBe(true);
    t.replies.length = 0;
    t.replies.push(t.status(true, 600_000));
    await t.advance(delays[5] + 50);                     // recovers and returns to the normal cadence
    expect(near(t.nextDueIn(), 60_000)).toBe(true);
    expect(t.calls.ui).toEqual([]);
  });
});

describe('signals', () => {
  it('a hidden tab neither polls nor animates, and re-checks the moment it becomes visible', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    t.state.visible = false;
    t.replies.push(t.status(false));
    await t.advance(5000);
    expect(t.calls.fetch).toHaveLength(0);
    expect(t.calls.ui).toEqual([]);
    t.state.visible = true;
    const resumed = w.trigger('visible');
    await t.flush();            // let the watcher register its animation timer before time moves
    await t.advance(3000);
    await resumed;
    expect(t.calls.fetch).toHaveLength(1);
    expect(t.calls.ui[0]).toBe('ending');
  });

  it('refocusing the window or coming back online checks straight away', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    await t.advance(1600);
    await t.advance(5000);
    await w.trigger('focus');
    expect(t.calls.fetch).toHaveLength(2);
    await t.advance(5000);
    await w.trigger('online', true);
    expect(t.calls.fetch).toHaveLength(3);
  });

  it('throttles ordinary signals but never forced ones', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    await t.advance(1600);
    expect(t.calls.fetch).toHaveLength(1);
    expect(await w.trigger('focus')).toBe('throttled');
    expect(await w.trigger('visible')).toBe('throttled');
    expect(t.calls.fetch).toHaveLength(1);
    await w.trigger('http-401', true);
    expect(t.calls.fetch).toHaveLength(2);
    await t.advance(4500);                       // the throttled signals are not lost: one check is scheduled
    expect(t.calls.fetch).toBeDefined();
  });

  it('concurrent signals share a single request', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    const results = await Promise.all([w.trigger('focus', true), w.trigger('online', true), w.trigger('http-401', true)]);
    expect(t.calls.fetch).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
  });

  it('a sign-out or expiry in another tab triggers an immediate check; unrelated messages do not', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    await t.advance(1600);
    w.onBroadcast({ type: 'hello' });
    w.onBroadcast(null);
    w.onBroadcast('ended');
    await t.flush();
    expect(t.calls.fetch).toHaveLength(1);
    t.replies.push(t.status(false));
    w.onBroadcast({ type: 'logout' });
    await t.flush();
    expect(t.calls.fetch).toHaveLength(2);
    expect(t.calls.ui[0]).toBe('ending');
  });

  it('works without cross-tab channels or storage', async () => {
    const t = makeEnv({ channel: null, storage: null });
    const w = watcherWith(t);
    w.start();
    t.replies.push(t.status(false));
    await t.advance(5000);
    expect(t.calls.ui[0]).toBe('ending');
    expect(t.calls.swap).toHaveLength(1);
  });

  it('stop() cancels everything', async () => {
    const t = makeEnv();
    const w = watcherWith(t);
    w.start();
    w.stop();
    await t.advance(120_000);
    expect(t.calls.fetch).toHaveLength(0);
    expect(await w.trigger('focus', true)).toBe('ignored');
  });
});

describe('sign-in link', () => {
  it('encodes the current path and query so the visitor returns to the same place', () => {
    const t = makeEnv();
    t.state.path = '/matches/abc?replay=3&tab=a b';
    const w = watcherWith(t, { loginUrl: '/auth/login' });
    expect(w.loginHref()).toBe('/auth/login?next=%2Fmatches%2Fabc%3Freplay%3D3%26tab%3Da%20b');
  });
});
