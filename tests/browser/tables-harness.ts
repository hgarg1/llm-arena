import ejs from 'ejs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

const root = path.join(__dirname, '..', '..');
const views = path.join(root, 'views');

const LONG_MODEL = 'anthropic/claude-3-5-sonnet-20241022-extended-reasoning-preview';
const ago = (days: number) => new Date(Date.UTC(2026, 10, 8) - days * 86_400_000);

const models = [
  { id: 'm1', name: LONG_MODEL, api_provider: 'openrouter', api_model_id: LONG_MODEL, kind: 'SINGLE', is_active: true, rating: 1612, rank: 1, winRate: 71, capabilities: ['chat', 'tools'], owner: { email: 'owner-with-a-fairly-long-address@example.com' }, composite: null },
  { id: 'm2', name: 'GPT-4o', api_provider: 'openai', api_model_id: 'gpt-4o', kind: 'SINGLE', is_active: true, rating: 1580, rank: 2, winRate: 64, capabilities: ['chat'], owner: null, composite: null },
  { id: 'm3', name: 'Llama 3.1 405B Instruct Turbo', api_provider: 'together', api_model_id: 'meta-llama/Llama-3.1-405B-Instruct-Turbo', kind: 'SINGLE', is_active: false, rating: 1522, rank: 3, winRate: 55, capabilities: [], owner: { email: 'a@b.co' }, composite: null },
  { id: 'm4', name: 'Mock Model', api_provider: 'mock', api_model_id: 'mock', kind: 'SINGLE', is_active: true, rating: 1400, rank: 4, winRate: 50, capabilities: [], owner: null, composite: null },
  { id: 'm5', name: 'Mistral Large', api_provider: 'mistral', api_model_id: 'mistral-large', kind: 'SINGLE', is_active: true, rating: 1380, rank: 5, winRate: 41, capabilities: [], owner: null, composite: null }
];

const participants = [
  { role: 'white', model: { name: LONG_MODEL } },
  { role: 'black', model: { name: 'GPT-4o' } }
];
const matches = ['COMPLETED', 'RUNNING', 'FAILED', 'PENDING', 'CANCELLED'].map((status, i) => ({
  id: `0a1b2c3d-4e5f-6789-abcd-ef01234567${i}${i}`, game_type: i % 2 ? 'texas_holdem' : 'chess_standard_variant', status, created_at: ago(i), finished_at: null, participants
}));

const userRow = (i: number) => ({
  id: `u${i}`, name: i === 0 ? 'Archie Garg-Subramanian the Third' : `User ${i}`, email: i === 0 ? 'archie.garg-with-a-long-address@harshit-garg.com' : `user${i}@example.com`,
  role: i === 0 ? 'ADMIN' : 'USER', tier: ['FREE', 'PRO', 'ENTERPRISE'][i % 3], banned: i === 2, plan: i % 2 ? { name: 'Team Plan' } : null,
  _count: { matches: i * 3 }, created_at: ago(30 + i), updated_at: ago(i)
});

const game = (i: number) => ({
  id: `g${i}`, key: `custom-game-key-${i}-with-a-long-identifier`, name: i ? `Custom Game ${i}` : 'Iterated Negotiation Deluxe', status: ['LIVE', 'DRAFT', 'SCHEDULED'][i % 3],
  settings: [{ tier_required: i % 2 ? 'PRO' : 'FREE' }], releases: [{ publish_at: ago(-2) }], updated_at: ago(i)
});

const base = {
  csrfToken: 'tok',
  user: { id: 'u0', email: 'archie@example.com', name: 'Archie Garg', tier: 'PRO', role: 'ADMIN', avatar_url: null },
  session: {},
  path: '/',
  title: 'Table test',
  seo: { title: 'T', description: 'd', canonicalPath: '/x', robots: 'noindex', structuredData: [] },
  settings: {},
  unreadChatCount: 0,
  can: () => true,
  success: undefined,
  error: undefined,
  query: {} as any
};

export interface TablePage {
  /** key text that must be visible on the page */
  text: string[];
  view: string;
  locals: Record<string, any>;
  /** a selector for the table-like element(s) that must not be clipped */
  admin?: boolean;
}

export const pages: Record<string, TablePage> = {
  home: {
    view: 'public/home.ejs', text: ['Latest Benchmarks', 'View Full Leaderboard', 'SCORE (MOCK)'],
    locals: { path: '/', models, matches: matches.slice(0, 3).map(m => ({ ...m, participants })) }
  },
  benchmarks: {
    view: 'public/benchmarks.ejs', text: ['Benchmarks'],
    locals: { path: '/benchmarks', models, top3: models.slice(0, 3), totalPages: 3, currentPage: 2 }
  },
  'match-history': {
    view: 'matches/list.ejs', text: ['Match History', 'Replay'],
    locals: {
      path: '/matches', matches, games: [{ key: 'chess', name: 'Chess' }], statuses: ['PENDING', 'RUNNING', 'COMPLETED'], queueEnabled: false,
      query: { search: '', gameType: '', status: '' }, pagination: { page: 2, totalPages: 4 }
    }
  },
  filings: { view: 'investors/filings.ejs', text: ['SEC Filings', 'Quarterly report pursuant to Section 13 or 15(d)'], locals: { path: '/investors/filings' } },
  committees: { view: 'investors/governance/committees.ejs', text: ['Committee Composition', 'Dr. Elena Rostova'], locals: { path: '/investors/governance/committees' }, },
  'admin-users': {
    view: 'admin/users/list.ejs', text: ['User Management', 'Details'], admin: true,
    locals: { path: '/admin/users', users: [0, 1, 2, 3].map(userRow), plans: [{ id: 'p1', name: 'Team Plan' }] }
  },
  'admin-models': {
    view: 'admin/models/list.ejs', text: ['Model Registry'], admin: true,
    locals: {
      path: '/admin/models', models, owners: [], singleModels: models, providers: ['openai'], capabilities: ['chat'], selectedModel: null, debugPermissions: false
    }
  },
  'admin-matches': { view: 'admin/matches/list.ejs', text: ['Match Operations'], admin: true, locals: { path: '/admin/matches', matches, filter: undefined, queueEnabled: true } },
  'admin-games': { view: 'admin/games/index.ejs', text: ['Game Builder'], admin: true, locals: { path: '/admin/games', games: [0, 1, 2].map(game), builtInKeys: ['chess'], newId: undefined } },
  'admin-api-keys': {
    view: 'admin/api-keys/index.ejs', text: ['API Keys'], admin: true,
    locals: {
      path: '/admin/api-keys', scopes: [{ scope_key: 'matches.read' }], usageMap: { k1: 12 },
      keys: [{ id: 'k1', name: 'Production key for the leaderboard export job', prefix: 'abcd1234', key_hash: 'x'.repeat(64), user_id: 'u1', user: { email: 'someone.with.a.long.address@example.com' }, status: 'ACTIVE', scopes: [{ scope_key: 'matches.read' }, { scope_key: 'models.read' }, { scope_key: 'leaderboard.export' }], last_used: ago(1) }]
    }
  },
  'admin-approvals': {
    view: 'admin/approvals/index.ejs', text: ['Approvals'], admin: true,
    locals: {
      path: '/admin/approvals', stats: { PENDING: 1 }, permissions: ['admin.users.edit'], requesters: [{ id: 'u1', email: 'user1@example.com' }], status: 'PENDING',
      requests: [{ id: 'r1', requester: { email: 'user1@example.com' }, created_at: ago(1), permission_key: 'admin.users.edit', reason: 'Need to fix a typo in a customer record that is long', method: 'POST', path: '/admin/users/abc123/update', status: 'PENDING', reviewer: null }]
    }
  },
  'admin-blocks': {
    view: 'admin/approvals/blocks.ejs', text: ['User Blocks'], admin: true,
    locals: { path: '/admin/approvals/blocks', blocks: [{ id: 'b1', blocker: { email: 'a@example.com' }, blocked: { email: 'b@example.com' }, blocker_id: 'a', blocked_id: 'b', created_at: ago(1), capabilities: ['chat'] }] }
  },
  'admin-audit': {
    view: 'admin/audit/index.ejs', text: ['Audit Log'], admin: true,
    locals: {
      path: '/admin/audit', admins: [], actions: ['access.denied'], stats: { deniedCount: 1, totalCount: 2 },
      logs: [{ id: 'l1', created_at: ago(1), admin: { email: 'archie@example.com' }, action: 'access.denied', target: 'users/123', metadata: { path: '/admin/users', reason: 'x'.repeat(120) } }]
    }
  },
  'admin-queue': {
    view: 'admin/queue/index.ejs', text: ['Queue Inspector'], admin: true,
    locals: { path: '/admin/queue', counts: { waiting: 1, active: 0, failed: 1, delayed: 0, completed: 3 }, currentType: 'failed', queueEnabled: true, jobs: [{ id: 'job-12345678', data: { matchId: '0a1b2c3d-4e5f-6789' }, failedReason: 'Provider timeout after 30000ms while waiting for response', returnvalue: null }] }
  },
  'admin-runner': {
    view: 'admin/runner/index.ejs', text: ['Runner Health'], admin: true,
    locals: { path: '/admin/runner', stats: { mode: 'vercel', runningOrphaned: 1, runningLeased: 2, cap: 4, pending: 3, oldestPendingMinutes: 5, completed24h: 40, avgSlicesCompleted24h: 3, budgetFailures24h: 0, longestRunning: [{ id: '0a1b2c3d4e', game_type: 'chess', minutes: 12, moves: 40, slices: 2 }], throttleWaits24h: 2, failed24h: 2, cancelled24h: 1, providers: [{ provider: 'openrouter', calls: 12345, p50Ms: 1200, p95Ms: 9100, inputTokens: 1234567, outputTokens: 234567, rpm: 60, tpm: 100000 }] } }
  }
};

/** Pages without tables, added to the phone audit (footers, headers, forms, long copy). */
const simple = (view: string, text: string[], locals: Record<string, any> = {}): TablePage => ({ view, text, locals: { path: '/' + view.replace(/\.ejs$/, ''), ...locals } });
export const auditPages: Record<string, TablePage> = {
  about: simple('public/about.ejs', ['Building the evaluation backbone']),
  'how-it-works': simple('public/how-it-works.ejs', ['How']),
  methodology: simple('public/methodology.ejs', ['Methodology']),
  'use-cases': simple('public/use-cases.ejs', ['Use']),
  docs: simple('public/docs.ejs', ['Documentation']),
  terms: simple('public/terms.ejs', ['Terms']),
  privacy: simple('public/privacy.ejs', ['Privacy']),
  login: simple('auth/login.ejs', ['Sign in'], { user: null, next: '' }),
  signup: simple('auth/signup.ejs', ['Initialize Account'], { user: null }),
  'forgot-password': simple('auth/forgot-password.ejs', ['Account Recovery'], { user: null }),
  'investors-home': simple('investors/home.ejs', ['Investor'], { path: '/investors', content: new Proxy({}, { get: (_t, key) => (/metrics/.test(String(key)) ? '$42.1M' : `Sample ${String(key).split(':').pop()}`) }) }),
  'investors-faq': simple('investors/faq.ejs', ['FAQ'], { path: '/investors/faq' }),
  'investors-contact': simple('investors/contact.ejs', ['Transfer Agent'], { path: '/investors/contact' }),
  'investors-press': simple('investors/press.ejs', ['Press'], { path: '/investors/press' }),
  'investors-financials': simple('investors/financials.ejs', ['Financ'], { path: '/investors/financials' }),
  'error-404': simple('errors/404.ejs', ['404'], { user: null })
};

const decorate = (html: string) => html
  .replace('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js', '/vendor/alpine.js')
  .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g, '');

/** Serves the REAL views, rendered with fixture data, with the real tailwind build and stylesheets, so a browser can lay them out. */
export const startTablesSite = async (extra: Record<string, TablePage> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tables-site-'));
  const tailwindOut = path.join(dir, 'style.css');
  execFileSync('npx', ['tailwindcss', '-i', path.join(root, 'src/styles/input.css'), '-o', tailwindOut], { cwd: root, stdio: 'ignore' });
  const alpine = fs.readFileSync(require.resolve('alpinejs/dist/cdn.min.js'));
  const all = { ...pages, ...auditPages, ...extra };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (type: string, body: string | Buffer, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    try {
      if (url === '/css/style.css') return send('text/css', fs.readFileSync(tailwindOut));
      if (url.startsWith('/css/') || url.startsWith('/js/')) {
        const file = path.join(root, 'public', url);
        if (fs.existsSync(file)) return send(url.endsWith('.css') ? 'text/css' : 'application/javascript', fs.readFileSync(file));
      }
      if (url === '/vendor/alpine.js') return send('application/javascript', alpine);
      if (url === '/img/icon.svg') return send('image/svg+xml', fs.readFileSync(path.join(root, 'public/img/icon.svg')));
      const key = url.replace(/^\//, '');
      const page = all[key];
      if (!page) return send('text/plain', 'not found', 404);
      const html = await ejs.renderFile(path.join(views, page.view), { ...base, ...page.locals }, { views: [views] });
      return send('text/html', decorate(html));
    } catch (err: any) {
      send('text/plain', String(err?.stack || err), 500);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base: baseUrl, close: async () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};
