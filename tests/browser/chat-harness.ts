import ejs from 'ejs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

const root = path.join(__dirname, '..', '..');

export interface ChatScenario {
  channels?: number;          // how many conversations the user has
  empty?: boolean;            // the open thread has no messages
  readOnly?: boolean;         // the open channel is read-only
  maintenance?: boolean;      // chat maintenance mode (non-admin)
  errorBanner?: string;
  messages?: number;
  xss?: boolean;              // append one of the user's own messages containing hostile markup
}

const LONG_URL = 'https://example.com/a/very/long/unbroken/link/' + 'segment-'.repeat(40) + 'end?utm_source=newsletter&utm_medium=email&utm_campaign=' + 'x'.repeat(120);

const channelKinds = [
  { name: 'general', type: 'PUBLIC' },
  { name: 'announcements-and-release-notes-for-the-whole-company', type: 'SYSTEM', is_read_only: true },
  { name: 'dm-archie-and-someone-with-a-rather-long-name', type: 'PRIVATE' },
  { name: 'leadership', type: 'PRIVATE' },
  { name: 'admins-only', type: 'PUBLIC', min_role_required: 'ADMIN' },
  { name: 'pro-members-lounge', type: 'PUBLIC', entitlement_required: 'chat.pro' }
];

const buildChannels = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const kind = channelKinds[i % channelKinds.length];
    return { id: `ch-${i + 1}`, name: i < channelKinds.length ? kind.name : `${kind.name}-${i + 1}`, type: kind.type, is_read_only: Boolean((kind as any).is_read_only), min_role_required: (kind as any).min_role_required ?? null, entitlement_required: (kind as any).entitlement_required ?? null };
  });

const buildMessages = (count: number, meId: string, xss = false) => {
  const base = new Date('2026-11-08T12:00:00Z').getTime();
  const people = [
    { id: meId, name: 'Archie Garg', email: 'archie@example.com', avatar_url: null },
    { id: 'u2', name: 'Priya Raman-Subramanian', email: 'priya@example.com', avatar_url: null },
    { id: 'u3', name: 'Chen', email: 'chen@example.com', avatar_url: null }
  ];
  const bodies = [
    'Morning! Did the nightly benchmark finish?',
    'Yes, all 4 games completed. Replay links are in the thread below.',
    `Here is the dashboard: ${LONG_URL}`,
    'Supercalifragilisticexpialidocious' + 'o'.repeat(80),
    'Short one.',
    '```\nconst veryLongLine = "' + 'lorem ipsum '.repeat(30) + '";\n```',
    '| model | wins | losses | draws | notes |\n|---|---|---|---|---|\n| alpha-large | 120 | 80 | 5 | ' + 'long cell content '.repeat(8) + ' |\n| beta | 90 | 110 | 12 | fine |',
    'A normal paragraph of text that should wrap neatly across several lines on a narrow phone screen without any horizontal scrolling at all, even when it gets quite long indeed.',
    '- bullet one\n- bullet two\n- bullet three with `inline code` and **bold**'
  ];
  const msgs: any[] = Array.from({ length: count }, (_, i) => {
    const person = people[i % 3 === 0 ? 0 : (i % 3)];
    return {
      id: `m-${i + 1}`, user_id: person.id, type: 'TEXT', content: bodies[i % bodies.length], created_at: new Date(base + i * 60_000),
      deleted_at: null, is_edited: i % 7 === 0, sender: person, attachments: [] as any[]
    };
  });
  if (count > 6) {
    msgs[count - 5].attachments = [{ file_type: 'image/svg+xml', url: 'uploads/diagram.svg', file_name: 'diagram.svg', file_size: 4096 }];
    msgs[count - 4].attachments = [{ file_type: 'application/pdf', url: 'uploads/report.pdf', file_name: 'quarterly-evaluation-report-final-FINAL-v7-with-a-very-long-file-name.pdf', file_size: 912345 }];
    msgs.splice(count - 8, 0, { id: 'sys-1', user_id: null, type: 'SYSTEM', content: '**Maintenance window** tonight 02:00-03:00 UTC.', created_at: new Date(base), deleted_at: null, sender: null, attachments: [] });
  }
  if (xss) msgs.push({ id: 'm-xss', user_id: meId, type: 'TEXT', content: '</textarea><b id="pwn">pwn</b>', created_at: new Date(base + 99 * 60_000), deleted_at: null, is_edited: false, sender: people[0], attachments: [] });
  return msgs;
};

/** Serves the real chat view (rendered from the real EJS) with the real stylesheets and local copies of the page libraries. */
export const startChatSite = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-site-'));
  const tailwindOut = path.join(dir, 'style.css');
  execFileSync('npx', ['tailwindcss', '-i', path.join(root, 'src/styles/input.css'), '-o', tailwindOut], { cwd: root, stdio: 'ignore' });
  const alpine = fs.readFileSync(require.resolve('alpinejs/dist/cdn.min.js'));
  const marked = fs.readFileSync(path.join(root, 'node_modules', 'marked', 'marked.min.js'));
  const purify = fs.readFileSync(path.join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));
  const diagram = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#dbeafe"/><circle cx="800" cy="450" r="300" fill="#2563eb"/></svg>';

  let scenario: ChatScenario = {};
  const posts: Array<{ url: string; csrf: string | undefined; contentType: string | undefined }> = [];
  const me = { id: 'u1', email: 'archie@example.com', name: 'Archie Garg', role: 'USER', avatar_url: null };

  const render = async (activeId: string | null) => {
    const channels = buildChannels(scenario.channels ?? 25);
    const activeChannel = activeId ? channels.find(c => c.id === activeId) ?? null : null;
    if (activeChannel && scenario.readOnly) activeChannel.is_read_only = true;
    const html = await ejs.renderFile(path.join(root, 'views/chat/index.ejs'), {
      title: 'Chat', path: '/chat', user: me, csrfToken: 'test-token', settings: {}, unreadChatCount: 2, seo: {},
      can: () => false, channels, activeChannel,
      messages: activeChannel ? (scenario.empty ? [] : buildMessages(scenario.messages ?? 30, me.id, scenario.xss)) : [],
      error: scenario.errorBanner ?? null, success: null, chatMaintenanceMode: Boolean(scenario.maintenance), realtimeEnabled: false
    }, { views: [path.join(root, 'views')] });
    return html
      .replace('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js', '/vendor/alpine.js')
      .replace('https://cdn.jsdelivr.net/npm/marked/marked.min.js', '/vendor/marked.js')
      .replace('https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.8/purify.min.js', '/vendor/purify.js')
      .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '');
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (type: string, body: string | Buffer, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    try {
      if (url === '/css/style.css') return send('text/css', fs.readFileSync(tailwindOut));
      if (url === '/css/nav.css') return send('text/css', fs.readFileSync(path.join(root, 'public/css/nav.css')));
      if (url === '/css/chat.css') return send('text/css', fs.readFileSync(path.join(root, 'public/css/chat.css')));
      if (url === '/js/nav-state.js') return send('application/javascript', fs.readFileSync(path.join(root, 'public/js/nav-state.js')));
      if (url === '/css/session-watch.css') return send('text/css', fs.readFileSync(path.join(root, 'public/css/session-watch.css')));
      if (url === '/js/session-watch.js') return send('application/javascript', fs.readFileSync(path.join(root, 'public/js/session-watch.js')));
      if (url === '/auth/session') return send('application/json', JSON.stringify({ authenticated: true, expiresAt: null, serverTime: new Date().toISOString() }));
      if (url === '/vendor/alpine.js') return send('application/javascript', alpine);
      if (url === '/vendor/marked.js') return send('application/javascript', marked);
      if (url === '/vendor/purify.js') return send('application/javascript', purify);
      if (url === '/img/icon.svg') return send('image/svg+xml', fs.readFileSync(path.join(root, 'public/img/icon.svg')));
      if (url === '/uploads/diagram.svg') return send('image/svg+xml', diagram);
      if (url === '/manifest.json') return send('application/json', '{}');
      if (url.startsWith('/__scenario/')) { scenario = JSON.parse(decodeURIComponent(url.slice('/__scenario/'.length))); posts.length = 0; return send('text/plain', 'ok'); }
      if (url === '/__posts') return send('application/json', JSON.stringify(posts));
      if (url === '/chat/candidates') return send('application/json', JSON.stringify([{ id: 'u9', name: '<img src=x onerror=alert(1)>Eve', email: 'eve@example.com', avatar_url: null }]));
      if (req.method === 'POST' && /^\/chat\/channels\/[^/]+\/messages$/.test(url)) {
        posts.push({ url, csrf: req.headers['csrf-token'] as string | undefined, contentType: req.headers['content-type'] });
        return send('application/json', JSON.stringify({ success: true }));
      }
      const thread = /^\/chat\/channels\/([^/]+)$/.exec(url);
      if (thread) return send('text/html', await render(thread[1]));
      if (url === '/chat') return send('text/html', await render(null));
      return send('text/plain', 'not found', 404);
    } catch (err: any) {
      res.writeHead(500); res.end(String(err?.stack || err));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    scenario: async (next: ChatScenario = {}) => { await fetch(`${base}/__scenario/${encodeURIComponent(JSON.stringify(next))}`); },
    posts: async () => (await (await fetch(`${base}/__posts`)).json()) as typeof posts,
    close: async () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
};
