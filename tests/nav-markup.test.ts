import ejs from 'ejs';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const views = path.join(root, 'views');

const render = (viewer: { user?: any; admin?: boolean; unread?: number; path?: string; alert?: string } = {}) =>
  ejs.renderFile(path.join(views, 'partials/nav.ejs'), {
    path: viewer.path ?? '/',
    user: viewer.user ?? null,
    csrfToken: 'tok',
    settings: viewer.alert ? { global_alert: viewer.alert } : {},
    unreadChatCount: viewer.unread ?? 0,
    can: (permission: string) => Boolean(viewer.admin) && permission === 'admin.access'
  }, { views: [views] });

const member = { email: 'archie@example.com', name: 'Archie Garg' };

describe('navigation markup', () => {
  it('has a skip link to a real target in both layouts', async () => {
    const html = await render();
    expect(html).toContain('href="#main-content"');
    for (const layout of ['views/partials/header_layout.ejs', 'views/layouts/main.ejs']) {
      const source = fs.readFileSync(path.join(root, layout), 'utf8');
      expect(source).toContain('id="main-content"');
      expect(source).toContain('/css/nav.css');
    }
  });

  it('exposes distinct, labelled landmarks (no unlabelled duplicate navs)', async () => {
    const html = await render({ user: member });
    const labels = [...html.matchAll(/<nav[^>]*aria-label="([^"]+)"/g)].map(m => m[1]);
    expect(labels.sort()).toEqual(['Menu', 'Primary', 'Primary (compact)', 'Quick navigation'].sort());
    expect(html.match(/<nav(?![^>]*aria-label)/g)).toBeNull();
    expect(html).toContain('<header');
  });

  it('only one of the three navigation surfaces is reachable at a time (inert bindings)', async () => {
    const html = await render({ user: member });
    expect(html).toContain(':inert="condensed && desktop"');
    expect(html).toContain(':inert="!(condensed && desktop)"');
    expect(html).toContain(':inert="!(condensed && !desktop)"');
  });

  it('marks the current page with aria-current in every surface', async () => {
    const html = await render({ user: member, path: '/benchmarks' });
    const current = html.match(/href="\/benchmarks"[^>]*aria-current="page"/g) || [];
    expect(current.length).toBeGreaterThanOrEqual(4); // top bar, dock, tab bar, menu sheet
    expect(html).not.toMatch(/href="\/about"[^>]*aria-current="page"/);
  });

  it('highlights nested paths and treats / as exact', async () => {
    expect(await render({ path: '/matches/123' })).toMatch(/href="\/matches"[^>]*aria-current="page"/);
    expect(await render({ path: '/matches/123' })).not.toMatch(/href="\/"[^>]*aria-current="page"/);
    expect(await render({ path: '/' })).toMatch(/class="site-nav__tab is-active" aria-current="page"/);
  });

  it('signed-out visitors get Sign in / Get started and a Docs tab; no account menu or chat', async () => {
    const html = await render();
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain('href="/auth/signup"');
    expect(html).not.toContain('Account menu');
    expect(html).not.toContain('href="/chat"');
    expect(html).toMatch(/site-nav__tab[^>]*>\s*<span class="relative"><svg[\s\S]*?<\/span>\s*<span>Docs<\/span>/);
  });

  it('signed-in members get an account menu with sign-out (a POST form with a CSRF token) and a Chat tab', async () => {
    const html = await render({ user: member });
    expect(html).toContain('aria-label="Account menu for Archie Garg"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('action="/auth/logout" method="POST"');
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain('href="/chat"');
    expect(html).not.toContain('Get started');
  });

  it('the top bar and the dock account menus use separate state (a shared flag broke the visible menu)', async () => {
    const html = await render({ user: member });
    expect(html).toContain('@click="account = !account"');
    expect(html).toContain('@click="dockAccount = !dockAccount"');
    expect(html).toContain('x-show="account"');
    expect(html).toContain('x-show="dockAccount"');
  });

  it('the admin console link is shown only to admins', async () => {
    expect(await render({ user: member, admin: false })).not.toContain('href="/admin"');
    const html = await render({ user: member, admin: true });
    expect(html).toContain('href="/admin"');
    expect(html).toContain('Admin console');
  });

  it('shows unread chat counts accessibly and caps them at 9+', async () => {
    const few = await render({ user: member, unread: 3 });
    expect(few).toContain('aria-label="Chat (3 unread)"');
    expect(few).toContain('aria-hidden="true">3</span>');
    expect(await render({ user: member, unread: 27 })).toContain('9+');
    expect(await render({ user: member, unread: 0 })).not.toContain('unread)');
  });

  it('the menu sheet is a modal dialog with a labelled close button and focus management hooks', async () => {
    const html = await render({ user: member });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close menu"');
    expect(html).toContain('x-ref="sheet"');
    expect(html).toContain('@keydown.escape.window="closeSheet()"');
    expect(html).toContain('@keydown.tab="trapFocus($event)"');
  });

  it('every control is a real link or button, and decorative icons are hidden from assistive tech', async () => {
    const html = await render({ user: member, admin: true, unread: 2 });
    // the only non-interactive element with a click handler is the sheet backdrop (Escape and the close button are the accessible routes)
    const clickableDivs = html.match(/<div[^>]*@click(?!\.outside)[^>]*>/g) || [];
    expect(clickableDivs.every(d => d.includes('site-nav__backdrop'))).toBe(true);
    const svgs = html.match(/<svg[^>]*>/g) || [];
    expect(svgs.length).toBeGreaterThan(10);
    expect(svgs.every(s => s.includes('aria-hidden="true"'))).toBe(true);
    expect(html).not.toMatch(/<img(?![^>]*\balt=)[^>]*>/);
  });

  it('renders the global alert outside the sticky header so it scrolls away', async () => {
    const html = await render({ alert: 'Scheduled maintenance tonight' });
    expect(html).toContain('Scheduled maintenance tonight');
    expect(html.indexOf('Scheduled maintenance tonight')).toBeLessThan(html.indexOf('<header'));
    expect(await render()).not.toContain('role="status"');
  });

  it('escapes user-controlled text', async () => {
    const html = await render({ user: { email: 'x@example.com', name: '<script>alert(1)</script>' } });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps the page script small and dependency-free apart from Alpine and nav-state', async () => {
    const html = await render();
    expect(html).toContain('<script src="/js/nav-state.js"></script>');
    expect(html).toContain("Alpine.data('siteNav'");
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });
});

describe('nav.css contract', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/nav.css'), 'utf8');
  const rule = (selector: string) => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    return match ? match[1] : '';
  };

  it('does not set `display` on classes whose visibility is controlled by Tailwind utilities (regression: hamburger showed on desktop)', () => {
    for (const selector of ['.site-nav__link', '.site-nav__icon-btn']) {
      expect(rule(selector)).not.toBe('');
      expect(rule(selector)).not.toMatch(/\bdisplay\s*:/);
    }
  });

  it('the markup supplies the layout utilities those classes rely on', () => {
    const nav = fs.readFileSync(path.join(root, 'views/partials/nav.ejs'), 'utf8');
    for (const match of nav.matchAll(/class="([^"]*site-nav__icon-btn[^"]*)"/g)) expect(match[1]).toMatch(/inline-flex|md:inline-flex/);
    for (const match of nav.matchAll(/class="([^"]*site-nav__link[^"]*)"/g)) expect(match[1]).toMatch(/items-center/);
  });

  it('respects reduced motion, touch targets, safe areas and print', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toMatch(/any-pointer: coarse/);
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('@media print');
    expect(css).toMatch(/\[x-cloak\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('hover styles only apply on devices that can hover (no sticky hover on touch)', () => {
    const outside = css.replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/g, '');
    expect(outside).not.toMatch(/:hover\s*\{/);
  });

  it('uses the same 1024px breakpoint as the script', () => {
    expect(css).toContain('min-width: 1024px');
    expect(css).toContain('max-width: 1023.98px');
  });
});

describe('session watcher wiring', () => {
  it('is only loaded for signed-in pages, deferred, with its endpoint and sign-in URL', async () => {
    const signedIn = await render({ user: member });
    expect(signedIn).toMatch(/<script src="\/js\/session-watch\.js" defer data-signed-in="true" data-endpoint="\/auth\/session" data-login="\/auth\/login"><\/script>/);
    expect(await render()).not.toContain('session-watch');
  });

  it('both layouts load its stylesheet and the files exist', () => {
    for (const layout of ['views/partials/header_layout.ejs', 'views/layouts/main.ejs']) {
      expect(fs.readFileSync(path.join(root, layout), 'utf8')).toContain('/css/session-watch.css');
    }
    for (const file of ['public/js/session-watch.js', 'public/css/session-watch.css']) expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  it('the swap target exists in both layouts (the watcher replaces this container)', () => {
    for (const layout of ['views/partials/header_layout.ejs', 'views/layouts/main.ejs']) {
      expect(fs.readFileSync(path.join(root, layout), 'utf8')).toMatch(/<body[^>]*>\s*<div class="relative flex min-h-screen/);
    }
  });

  it('the login form carries the next path', () => {
    const login = fs.readFileSync(path.join(root, 'views/auth/login.ejs'), 'utf8');
    expect(login).toContain('name="next"');
  });
});
