import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const views = path.join(__dirname, '..', 'views');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.ejs') ? [p] : [];
  });

describe('EJS templates', () => {
  it.each(walk(views).map(p => [path.relative(views, p), p]))('%s compiles', (_name, file) => {
    expect(() => ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file, views: [views] })).not.toThrow();
  });
});

const baseLocals = {
  csrfToken: 'tok',
  user: { id: 'u1', email: 'tester@example.com', name: 'Tester', tier: 'FREE', role: 'USER' },
  session: {},
  path: '/x',
  title: 'T',
  seo: { title: 'T', description: 'd', canonicalPath: '/x', robots: 'noindex', structuredData: [] },
  can: () => true,
  success: undefined,
  error: undefined,
  verification: { state: 'unverified' }
};

const render = (file: string, data: any) =>
  ejs.renderFile(path.join(views, file), { ...baseLocals, ...data }, { views: [views] });

describe('rendered pages', () => {
  const match = (over: any = {}) => ({
    id: 'abc', game_type: 'texas_holdem', status: 'RUNNING', failure_reason: null,
    participants: [], events: [], created_at: new Date(), finished_at: null, tournament: null, ...over
  });

  it('replay page goes live while a match is running', async () => {
    const html = await render('matches/detail.ejs', { match: match(), renderer: 'poker', boardSize: 100 });
    expect(html).toContain("replayViewer('abc', 'RUNNING', 100)");
    expect(html).toContain('Live: updating as moves are played');
    expect(html).toContain('X-Match-Status');
  });

  it('replay page explains failures and truncation', async () => {
    const failed = await render('matches/detail.ejs', { match: match({ status: 'FAILED', failure_reason: 'provider down' }), renderer: 'poker', boardSize: 100 });
    expect(failed).toContain('This match failed: provider down');
    const truncated = await render('matches/detail.ejs', { match: match({ status: 'COMPLETED', failure_reason: 'Stopped after 5 turns without a result' }), renderer: 'poker', boardSize: 100 });
    expect(truncated).toContain('Stopped after 5 turns without a result');
    expect(truncated).not.toContain('This match failed');
  });

  it('create page shows the reason a creation failed', async () => {
    const html = await render('matches/create.ejs', { models: [], gameDefaults: {}, gameCatalog: {}, queueEnabled: true, error: 'Select a model for black' });
    expect(html).toContain('Select a model for black');
    expect(html).not.toContain('Fixed stack (1000)');
  });

  const game = { id: 'g1', key: 'my-game', name: 'My Game', roles: ['a', 'b'], capabilities: [], max_players: 2, status: 'DRAFT', assets: null, settings: [], releases: [], ui_schema: null };
  const wizard = (dryRun: any) => render('admin/games/wizard.ejs', {
    game, step: 'review', engineArtifact: null, latestDryRun: dryRun, simulationEvents: dryRun?.events || null, builtInReadOnly: false,
    warnings: [], diffSummary: null, uiPreview: [], warning: undefined
  });

  it('wizard review lists every validation check with its outcome', async () => {
    const html = await wizard({
      success: false, engine_artifact_id: 'a', error_message: 'x', events: [],
      checks: [{ name: 'Initializes with valid events', ok: true }, { name: 'Plays 5 seeded games to completion', ok: false, detail: 'Game 1 did not finish within 500 moves' }]
    });
    expect(html).toContain('Initializes with valid events');
    expect(html).toContain('Game 1 did not finish within 500 moves');
    expect(html).toContain('Passed: ');
    expect(html).toContain('Failed: ');
    expect(html).toContain('Retire this game?');
  });

  it('wizard review still renders for legacy dry runs without checks', async () => {
    const html = await wizard({ success: false, engine_artifact_id: 'a', error_message: 'legacy failure', events: [], checks: null });
    expect(html).toContain('legacy failure');
  });

  describe('replay renderers', () => {
    const participants = [
      { role: 'p1', score: 1, model: { name: 'Model A' } },
      { role: 'p2', score: 0, model: { name: 'Model B' } }
    ];
    const page = (renderer: string, over: any = {}) =>
      render('matches/detail.ejs', { match: match({ game_type: 'custom-game', status: 'COMPLETED', participants, ...over }), renderer, boardSize: 100 });

    it('generic games get a scoreboard with scores and move counts', async () => {
      const html = await page('generic');
      expect(html).toContain('aria-label="Scoreboard"');
      expect(html).toContain('Model A');
      expect(html).toContain('Final score');
      expect(html).not.toContain('id="board-container"');
    });

    it('specialised renderers show their board and no generic scoreboard', async () => {
      const chess = await page('chess', { game_type: 'chess' });
      expect(chess).toContain('id="board-container"');
      expect(chess).not.toContain('aria-label="Scoreboard"');
      const chutes = await page('chutes', { game_type: 'chutes_and_ladders' });
      expect(chutes).toContain('x-html="transitionsSvg()"');
      expect(chutes).not.toContain('<line x1="5%" y1="95%"');
    });

    it('shows a banner for cancelled matches', async () => {
      expect(await page('generic', { status: 'CANCELLED' })).toContain('cancelled by an administrator');
    });

    const viewer = async (size = 100, fetchImpl: any = async () => ({}), windowStub: any = {}) => {
      const html = await render('matches/detail.ejs', { match: match({ status: 'COMPLETED' }), renderer: 'chutes', boardSize: size });
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(code => code.includes('function replayViewer'));
      expect(scripts).toHaveLength(1);
      class Chess { reset() {} load() {} board() { return []; } }
      const sandbox: any = { console, window: windowStub, document: {}, fetch: fetchImpl, Chess, setInterval: () => 0, clearInterval: () => undefined };
      vm.createContext(sandbox);
      vm.runInContext(scripts[0], sandbox); // throws on any syntax error in the page script
      return sandbox.replayViewer('m', 'COMPLETED', size);
    };

    it('the replay page script parses and exposes the board maths', async () => {
      const v = await viewer(100);
      expect(v.boardRows).toBe(10);
      // Square 1 is bottom-left; row 2 runs right-to-left, so square 11 is bottom-right of row 2.
      const one = v.cellCenter(1);
      expect(one.x).toBeCloseTo(5); expect(one.y).toBeCloseTo(95);
      const eleven = v.cellCenter(11);
      expect(eleven.x).toBeCloseTo(95); expect(eleven.y).toBeCloseTo(85);
      expect(v.getGridStyle(1)).toContain('10 / 1');
    });

    it('draws the layout the engine published, at any board size', async () => {
      const v = await viewer(50);
      expect(v.boardRows).toBe(5);
      v.transitions = [{ from: 3, to: 20 }, { from: 40, to: 12 }];
      const svg = v.transitionsSvg();
      expect(svg.match(/<line /g)).toHaveLength(2);
      expect(svg).toContain('arrowhead-ladder');
      expect(svg).toContain('arrowhead-chute');
      expect(v.getGridStyle(1)).toContain('5 / 1');
    });

    it('falls back to the standard layout for old matches without one', async () => {
      const v = await viewer(100);
      expect(v.transitionsSvg().match(/<line /g)).toHaveLength(19);
      const small = await viewer(50);
      expect((small.transitionsSvg().match(/<line /g) || []).length).toBeLessThan(19);
    });

    const reply = (events: any[], status: string) => ({ ok: true, headers: { get: (h: string) => (h === 'X-Match-Status' ? status : null) }, json: async () => events });
    const ev = (seq: number, type = 'STEP') => ({ id: `e${seq}`, seq, type, payload: {}, actor_role: 'system', turn_index: seq });

    it('live polling fetches only newer events and appends them without duplicates', async () => {
      const urls: string[] = [];
      const pages = [reply([ev(0, 'MATCH_START'), ev(1)], 'RUNNING'), reply([ev(2), ev(1)], 'RUNNING')];
      const v = await viewer(100, async (url: string) => { urls.push(url); return pages.shift(); });
      v.matchId = 'm1';
      v.live = true;
      await v.loadEvents();
      await v.loadEvents();
      expect(urls).toEqual(['/matches/m1/events', '/matches/m1/events?after=1']);
      expect(v.events.map((e: any) => e.seq)).toEqual([0, 1, 2]); // seq 1 came back again and was ignored
    });

    it('follows the tail while live, but does not yank a viewer who scrubbed back', async () => {
      const pages = [reply([ev(0), ev(1), ev(2)], 'RUNNING'), reply([ev(3)], 'RUNNING'), reply([ev(4)], 'RUNNING')];
      const v = await viewer(100, async () => pages.shift());
      v.matchId = 'm1';
      v.live = true;
      await v.loadEvents();
      v.currentIndex = 2;                 // at the live edge
      await v.loadEvents();
      expect(v.currentIndex).toBe(3);     // followed
      v.currentIndex = 1;                 // user scrubbed back
      await v.loadEvents();
      expect(v.currentIndex).toBe(1);     // left alone
      expect(v.events).toHaveLength(5);
    });

    it('stops polling and reloads once the match reaches a final status', async () => {
      const reload = jest.fn();
      const v = await viewer(100, async () => reply([ev(0)], 'COMPLETED'), { location: { reload } });
      v.matchId = 'm1';
      v.live = true;
      await v.loadEvents();
      expect(v.live).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('surfaces fetch failures to the caller instead of corrupting state', async () => {
      const v = await viewer(100, async () => ({ ok: false }));
      v.matchId = 'm1';
      await expect(v.loadEvents()).rejects.toThrow('Failed to load events');
      expect(v.events).toEqual([]);
    });

    it('colours any role deterministically and never shows an empty initial', async () => {
      const v = await viewer();
      expect(v.roleColor('alpha')).toBe(v.roleColor('alpha'));
      expect(v.roleInitial('seat3')).toBe('S3');
      expect(v.roleInitial('system')).toBe('S');
      expect(v.roleInitial(undefined)).toBe('?');
    });
  });
});

describe('admin queue page', () => {
  const jobs = [{ id: 'j1', data: { matchId: 'abcdef123456' }, failedReason: null, returnvalue: null, timestamp: Date.now() }];
  const page = (currentType: string) => render('admin/queue/index.ejs', {
    jobs, counts: { active: 1, waiting: 1, completed: 0, failed: 1, delayed: 0 }, currentType, queueEnabled: true
  });

  it('offers cancel for waiting and active jobs and retry only for failed ones', async () => {
    const waiting = await page('waiting');
    expect(waiting).toContain('/admin/matches/abcdef123456/cancel');
    expect(waiting).not.toContain('/admin/queue/j1/retry');
    const failed = await page('failed');
    expect(failed).toContain('/admin/queue/j1/retry');
    expect(failed).not.toContain('/cancel');
  });
});

describe('admin runner health page', () => {
  const stats = (over: any = {}) => ({
    mode: 'vercel', cap: 50, pending: 3, oldestPendingMinutes: 12, runningLeased: 7, runningOrphaned: 0,
    completed24h: 40, failed24h: 2, cancelled24h: 1, budgetFailures24h: 1, throttleWaits24h: 0, avgSlicesCompleted24h: 2.5,
    providers: [{ provider: 'openai', calls: 1234, p50Ms: 2100, p95Ms: 9800, inputTokens: 5000000, outputTokens: 40000, rpm: 500, tpm: 200000 }],
    longestRunning: [{ id: 'abcdef1234567890', game_type: 'chess', minutes: 42, slices: 9, moves: 120 }],
    ...over
  });
  const page = (s: any) => render('admin/runner/index.ejs', { stats: s });

  it('shows the numbers, the cap and per-provider latency with limits', async () => {
    const html = await page(stats());
    expect(html).toContain('Runner Health');
    expect(html).toContain('of 50');
    expect(html).toContain('oldest has waited 12 min');
    expect(html).toContain('2.1 s');
    expect(html).toContain('9.8 s');
    expect(html).toContain('1,234');
    expect(html).toContain('500 req/min, 200,000 tok/min');
    expect(html).toContain('/matches/abcdef1234567890');
    expect(html).not.toContain('role="alert"');
  });

  it('warns when no runner is configured, and when matches are orphaned', async () => {
    expect(await page(stats({ mode: 'none' }))).toContain('No match runner is configured');
    const orphaned = await page(stats({ runningOrphaned: 3 }));
    expect(orphaned).toContain('3 running match(es) have no live runner');
  });

  it('handles an idle system gracefully', async () => {
    const html = await page(stats({ pending: 0, oldestPendingMinutes: null, providers: [], longestRunning: [], avgSlicesCompleted24h: null }));
    expect(html).toContain('queue is empty');
    expect(html).toContain('No model calls in the last hour');
    expect(html).toContain('Nothing is running');
    expect(html).toContain('n/a');
  });

  it('marks unlimited providers and is reachable from the admin navigation', async () => {
    const html = await page(stats({ providers: [{ provider: 'anthropic', calls: 1, p50Ms: 1000, p95Ms: 1000, inputTokens: 1, outputTokens: 1, rpm: null, tpm: null }] }));
    expect(html).toContain('unlimited');
    expect(html).toContain('href="/admin/runner"');
  });
});
