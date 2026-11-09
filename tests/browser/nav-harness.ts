import ejs from 'ejs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

const root = path.join(__dirname, '..', '..');

export interface Viewer {
  user?: { email: string; name?: string; avatar_url?: string } | null;
  admin?: boolean;
  unread?: number;
  path?: string;
  alert?: string;
}

/**
 * Serves the real navigation (rendered from the real EJS partials) on a long page, with the real stylesheets,
 * script and a local copy of Alpine, so a browser can exercise it without network access.
 */
export const startNavSite = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-site-'));
  const tailwindOut = path.join(dir, 'style.css');
  execFileSync('npx', ['tailwindcss', '-i', path.join(root, 'src/styles/input.css'), '-o', tailwindOut], { cwd: root, stdio: 'ignore' });
  const alpine = fs.readFileSync(require.resolve('alpinejs/dist/cdn.min.js'));

  const page = async (viewer: Viewer) => {
    const html = await ejs.renderFile(path.join(root, 'views/partials/header_layout.ejs'), {
      title: 'Nav test',
      path: viewer.path ?? '/',
      user: viewer.user ?? null,
      csrfToken: 'test-token',
      settings: viewer.alert ? { global_alert: viewer.alert } : {},
      unreadChatCount: viewer.unread ?? 0,
      can: (permission: string) => Boolean(viewer.admin) && permission === 'admin.access',
      seo: {}
    }, { views: [path.join(root, 'views')] });
    const filler = Array.from({ length: 60 }, (_, i) => `<section style="padding:48px 0"><h2>Section ${i + 1}</h2><p>${'Lorem ipsum dolor sit amet. '.repeat(18)}</p></section>`).join('');
    return html
      .replace('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js', '/vendor/alpine.js')
      .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
      + `<div class="container mx-auto px-4" id="filler">${filler}</div></main></div></body></html>`;
  };

  let current: Viewer = {};
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (type: string, body: string | Buffer) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    try {
      if (url === '/css/style.css') return send('text/css', fs.readFileSync(tailwindOut));
      if (url === '/css/nav.css') return send('text/css', fs.readFileSync(path.join(root, 'public/css/nav.css')));
      if (url === '/js/nav-state.js') return send('application/javascript', fs.readFileSync(path.join(root, 'public/js/nav-state.js')));
      if (url === '/css/session-watch.css') return send('text/css', fs.readFileSync(path.join(root, 'public/css/session-watch.css')));
      if (url === '/js/session-watch.js') return send('application/javascript', fs.readFileSync(path.join(root, 'public/js/session-watch.js')));
      if (url === '/auth/session') return send('application/json', JSON.stringify({ authenticated: true, expiresAt: null, serverTime: new Date().toISOString() }));
      if (url === '/vendor/alpine.js') return send('application/javascript', alpine);
      if (url === '/img/icon.svg') return send('image/svg+xml', fs.readFileSync(path.join(root, 'public/img/icon.svg')));
      if (url.startsWith('/__viewer')) { current = JSON.parse(decodeURIComponent(url.slice('/__viewer/'.length))); return send('text/plain', 'ok'); }
      if (url === '/manifest.json') return send('application/json', '{}');
      return send('text/html', await page(current));
    } catch (err: any) {
      res.writeHead(500); res.end(String(err?.stack || err));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    as: async (viewer: Viewer) => { await fetch(`${base}/__viewer/${encodeURIComponent(JSON.stringify(viewer))}`); },
    close: async () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
};
