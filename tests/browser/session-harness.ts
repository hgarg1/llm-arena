import ejs from 'ejs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

const root = path.join(__dirname, '..', '..');
const member = { email: 'archie@example.com', name: 'Archie Garg' };

export interface SessionSiteState {
  signedIn: boolean;
  /** `ok` answers normally; `down` answers 503; `drop` kills the connection; `garbage` answers 200 with a non-JSON body. */
  statusMode: 'ok' | 'down' | 'drop' | 'garbage';
  polls: number;
  pageLoads: number;
  loginRequests: string[];
}

/**
 * A tiny stand-in for the real app: the real navigation/layout EJS, the real watcher script and styles, a status endpoint
 * the test can flip, a public page (`/`, `/benchmarks`) that renders for both visitors, and a protected page (`/account`)
 * that answers 401 when signed out, exactly like `isAuthenticated`.
 */
export const startSessionSite = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-site-'));
  const tailwindOut = path.join(dir, 'style.css');
  execFileSync('npx', ['tailwindcss', '-i', path.join(root, 'src/styles/input.css'), '-o', tailwindOut], { cwd: root, stdio: 'ignore' });
  const alpine = fs.readFileSync(require.resolve('alpinejs/dist/cdn.min.js'));
  const state: SessionSiteState = { signedIn: true, statusMode: 'ok', polls: 0, pageLoads: 0, loginRequests: [] };

  const layout = async (pathname: string, body: string) => {
    const html = await ejs.renderFile(path.join(root, 'views/partials/header_layout.ejs'), {
      title: state.signedIn ? 'Signed-in page' : 'Signed-out page',
      path: pathname,
      user: state.signedIn ? member : null,
      csrfToken: state.signedIn ? 'csrf-signed-in' : 'csrf-anonymous',
      settings: {}, unreadChatCount: 0, can: () => false, seo: {}
    }, { views: [path.join(root, 'views')] });
    return html
      .replace('https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js', '/vendor/alpine.js')
      .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '')
      + `<div class="container mx-auto px-4" id="content">${body}</div></main></div></body></html>`;
  };
  const content = (title: string) => `<h1 id="page-title" class="text-3xl font-bold py-10">${title}</h1><p>${state.signedIn ? 'Welcome back, Archie.' : 'Welcome, visitor. Sign in to continue.'}</p>`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const send = (type: string, body: string | Buffer, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (url.pathname === '/css/style.css') return send('text/css', fs.readFileSync(tailwindOut));
      for (const file of ['css/nav.css', 'css/session-watch.css']) if (url.pathname === `/${file}`) return send('text/css', fs.readFileSync(path.join(root, 'public', file)));
      for (const file of ['js/nav-state.js', 'js/session-watch.js']) if (url.pathname === `/${file}`) return send('application/javascript', fs.readFileSync(path.join(root, 'public', file)));
      if (url.pathname === '/vendor/alpine.js') return send('application/javascript', alpine);
      if (url.pathname === '/img/icon.svg') return send('image/svg+xml', fs.readFileSync(path.join(root, 'public/img/icon.svg')));
      if (url.pathname === '/manifest.json') return send('application/json', '{}');

      if (url.pathname === '/auth/session') {
        state.polls++;
        if (state.statusMode === 'drop') return req.socket.destroy();
        if (state.statusMode === 'down') return send('application/json', '{"error":"unavailable"}', 503);
        if (state.statusMode === 'garbage') return send('text/html', '<html>gateway</html>');
        const now = Date.now();
        return send('application/json', JSON.stringify({ authenticated: state.signedIn, expiresAt: state.signedIn ? new Date(now + 30 * 60_000).toISOString() : null, serverTime: new Date(now).toISOString() }));
      }
      if (url.pathname === '/auth/login') {
        state.loginRequests.push(url.search);
        return send('text/html', await layout('/auth/login', `<h1 id="page-title">Sign in</h1>`));
      }
      if (url.pathname === '/account' && !state.signedIn) return send('text/html', '<h1>401 Please sign in</h1>', 401);
      if (url.pathname === '/__state') {
        Object.assign(state, JSON.parse(decodeURIComponent(url.search.slice(1))));
        return send('text/plain', 'ok');
      }
      if (url.pathname === '/api/protected') return send('application/json', '{"error":"unauthorized"}', state.signedIn ? 200 : 401);
      if (url.pathname === '/' || url.pathname === '/benchmarks' || url.pathname === '/account') {
        state.pageLoads++;
        return send('text/html', await layout(url.pathname, content(url.pathname === '/account' ? 'Your account' : 'Benchmarks')));
      }
      return send('text/plain', 'not found', 404);
    } catch (err: any) {
      res.writeHead(500); res.end(String(err?.stack || err));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, state,
    close: async () => { server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
};
