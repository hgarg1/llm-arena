/// <reference lib="dom" />
/**
 * Real-browser phone audit of the signed-in app pages: match wizard, replay viewer (every renderer), models, account.
 * Opt in with BROWSER_TESTS=1. Renders the REAL EJS views with fixture data and the real tailwind build at 360x740 and 390x844, then
 * drives the Alpine UI (wizard games, replay playback, modals) and re-checks every state for sideways page scroll, clipped content,
 * small tap targets and tiny text. Set APP_SCREENSHOTS=<dir> to save screenshots.
 */
import { Browser, BrowserContext, Page, chromium } from 'playwright-core';
import fs from 'fs';
import { startTablesSite } from './tables-harness';
import { apiModels, appPages, replayEvents } from './app-pages-harness';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const shots = process.env.APP_SCREENSHOTS;

const PHONES = [
  { name: '360x740', viewport: { width: 360, height: 740 } },
  { name: '390x844', viewport: { width: 390, height: 844 } }
];

const LANDSCAPES = [
  { name: '844x390', viewport: { width: 844, height: 390 } },
  { name: '740x360', viewport: { width: 740, height: 360 } },
  { name: '667x375', viewport: { width: 667, height: 375 } }
];

const TAP_SELECTOR = [
  'main a.btn', 'main button', 'main select', 'main input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])',
  'main textarea', '[data-account-link]', 'main a[href^="/matches/"]', 'main a[href^="/models/"]', 'main a[href="/matches"]', 'main a[href="/models"]'
].join(',');

/** Stand-in for chess.js 0.10 (the page loads it from a CDN): just enough to parse a FEN into board(). */
const CHESS_STUB = `window.Chess = function () {
  var START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', fen = START;
  this.reset = function () { fen = START; };
  this.load = function (f) { fen = f; return true; };
  this.board = function () {
    return fen.split(' ')[0].split('/').map(function (row) {
      var out = [];
      row.split('').forEach(function (ch) {
        if (/\\d/.test(ch)) { for (var i = 0; i < +ch; i++) out.push(null); }
        else out.push({ type: ch.toLowerCase(), color: ch === ch.toLowerCase() ? 'b' : 'w' });
      });
      return out;
    });
  };
};`;

interface Report { overflowPage: number; overflowMain: number; clipped: string[]; hiddenClip: string[]; small: string[]; tiny: string[]; text: string; }

const audit = (tab: Page): Promise<Report> => tab.evaluate(({ tapSelector }) => {
  const width = window.innerWidth;
  const insideScroller = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1 && p.clientWidth <= width) return true;
    }
    return false;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden') return false;
    for (let p: Element | null = el; p; p = p.parentElement) { if (getComputedStyle(p).display === 'none') return false; }
    return true;
  };
  const skip = (el: Element) => el.closest('svg') || el.closest('.sr-only') || el.closest('.site-nav__skip') || el.closest('[aria-hidden="true"]') || el.closest('.pointer-events-none');
  const label = (el: Element) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 50)} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent || '').trim().slice(0, 28)}"`; };
  const overflowPage = document.documentElement.scrollWidth - width;
  const main = document.querySelector('main');
  const overflowMain = main ? main.scrollWidth - main.clientWidth : 0;
  const clipped: string[] = [];
  const hiddenClip: string[] = [];
  document.querySelectorAll('main *').forEach(el => {
    if (!visible(el) || skip(el)) return;
    const r = el.getBoundingClientRect();
    if ((r.right > width + 1 || r.left < -1) && !insideScroller(el)) clipped.push(label(el));
    // content cut off by an ancestor that clips (overflow hidden) without scrolling: the page itself does not overflow, but users lose content
    const own = Array.from(el.childNodes).some(n => (n.nodeType === 3 && (n.textContent || '').trim().length > 0)) || el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'SELECT';
    if (!own) return;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|clip)/.test(s.overflowX) && !/(auto|scroll)/.test(s.overflowX) && !/ellipsis/.test(getComputedStyle(el).textOverflow)) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1.5 || r.left < pr.left - 1.5) { hiddenClip.push(`${label(el)} inside ${p.tagName.toLowerCase()}.${String(p.className).slice(0, 40)} [${Math.round(pr.left)}..${Math.round(pr.right)}]`); break; }
      }
    }
  });
  const small: string[] = [];
  document.querySelectorAll(tapSelector).forEach(el => {
    if (!visible(el) || el.closest('header') || el.closest('aside.hidden')) return;
    // a link inside a sentence is not a standalone tap target
    if (el.tagName === 'A' && el.parentElement && Array.from(el.parentElement.childNodes).filter(n => n.nodeType === 3).map(n => (n.textContent || '').trim()).join('').length > 12) return;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5) small.push(`${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  });
  const tiny: string[] = [];
  document.querySelectorAll('main *').forEach(el => {
    if (!visible(el)) return;
    const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || '').trim().length > 2);
    if (own && parseFloat(getComputedStyle(el).fontSize) < 11.5) tiny.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 24)}" ${getComputedStyle(el).fontSize}`);
  });
  return { overflowPage, overflowMain, clipped: clipped.slice(0, 8), hiddenClip: hiddenClip.slice(0, 8), small: small.slice(0, 8), tiny: tiny.slice(0, 8), text: document.body.innerText };
}, { tapSelector: TAP_SELECTOR });

// APP_REPORT=<file> collects findings instead of failing, to survey a page before fixing it.
const findings: Record<string, any>[] = [];
const expectClean = (report: Report, where: string) => {
  if (process.env.APP_REPORT) {
    const bad = { clipped: report.clipped, hiddenClip: report.hiddenClip, small: report.small, tiny: report.tiny, overflowPage: report.overflowPage, overflowMain: report.overflowMain };
    if (Object.values(bad).some(v => (Array.isArray(v) ? v.length : v > 0))) findings.push({ where, ...bad });
    return;
  }
  const summary = { where, overflowPage: report.overflowPage, overflowMain: report.overflowMain, clipped: report.clipped, hiddenClip: report.hiddenClip, small: report.small, tiny: report.tiny };
  expect({ ...summary, overflowPage: Math.max(0, report.overflowPage), overflowMain: Math.max(0, report.overflowMain) }).toEqual({ where, overflowPage: 0, overflowMain: 0, clipped: [], hiddenClip: [], small: [], tiny: [] });
};

maybe('signed-in app pages on phones', () => {
  let site: Awaited<ReturnType<typeof startTablesSite>>;
  let browser: Browser;

  beforeAll(async () => {
    site = await startTablesSite(appPages);
    browser = await chromium.launch();
    if (shots) fs.mkdirSync(shots, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    await browser?.close(); await site?.close();
    if (process.env.APP_REPORT) fs.writeFileSync(process.env.APP_REPORT, JSON.stringify(findings, null, 1));
  });

  const open = async (phone: { viewport: { width: number; height: number } }, name: string, opts: { desktop?: boolean } = {}) => {
    const context: BrowserContext = await browser.newContext(opts.desktop
      ? { viewport: { width: 1280, height: 800 } }
      : { viewport: phone.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    // nothing leaves the machine: CDN scripts are stubbed or dropped, the JSON endpoints are faked
    await context.route(url => !url.href.startsWith(site.base), route => {
      if (/chess\.min\.js/.test(route.request().url())) return route.fulfill({ contentType: 'application/javascript', body: CHESS_STUB });
      return route.abort();
    });
    await context.route(/\/api\/models/, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(apiModels) }));
    await context.route(/\/matches\/[^/]+\/events/, route => {
      const kind = /\/matches\/([a-z0-9]+)-/.exec(route.request().url())![1];
      route.fulfill({ contentType: 'application/json', headers: { 'X-Match-Status': kind === 'live' ? 'RUNNING' : 'COMPLETED' }, body: JSON.stringify(replayEvents(kind)) });
    });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on('pageerror', e => errors.push(e.message));
    const response = await tab.goto(`${site.base}/${name}`, { waitUntil: 'load' });
    expect(response!.status()).toBe(200);
    await tab.waitForTimeout(250);
    return { context, tab, errors };
  };
  /** Full-page screenshot, plus 1300px slices of tall pages so they can be inspected at a readable scale. */
  const shot = async (tab: Page, file: string) => {
    if (!shots) return;
    await tab.screenshot({ path: `${shots}/${file}.png`, fullPage: true });
    const { height, width } = await tab.evaluate(() => ({ height: document.documentElement.scrollHeight, width: window.innerWidth }));
    for (let y = 0, n = 1; height > 1500 && y < height; y += 1300, n++) {
      await tab.screenshot({ path: `${shots}/${file}.part${n}.png`, fullPage: true, clip: { x: 0, y, width, height: Math.min(1300, height - y) } });
    }
  };

  describe.each(PHONES)('$name', phone => {
    it.each(Object.entries(appPages))('%s lays out cleanly', async (name, page) => {
      const { context, tab, errors } = await open(phone, name);
      const report = await audit(tab);
      await shot(tab, `${name}-${phone.name}`);
      await context.close();
      expect(errors).toEqual([]);
      for (const t of page.text) expect(report.text).toContain(t);
      expectClean(report, name);
    }, 60_000);

    it('match wizard stays clean for every game and with models chosen', async () => {
      for (const [name, tier] of [['match-create', 'PRO'], ['match-create-enterprise', 'ENTERPRISE']]) {
        const { context, tab, errors } = await open(phone, name);
        const games = ['chess', 'texas_holdem', 'blackjack', 'chutes_and_ladders', 'iterated-prisoners-dilemma-with-reputation-and-communication-channel'];
        for (const game of games) {
          await tab.selectOption('select[name="gameType"]', game);
          await tab.waitForTimeout(150);
          if (game === 'texas_holdem' || game === 'blackjack') await tab.selectOption('select[name="playerCount"]', '6');
          await tab.waitForTimeout(100);
          // choose the long-named model in every seat
          const seats = await tab.locator('select[name^="model"]').count();
          for (let i = 1; i <= seats; i++) await tab.selectOption(`select[name="model${i}Id"]`, i % 2 ? 'm1' : 'm6');
          await tab.fill('input[placeholder="Search models..."] >> nth=0', 'claude-3-5-sonnet-20241022-extended');
          await tab.waitForTimeout(100);
          await shot(tab, `${name}-${game.slice(0, 12)}-${phone.name}`);
          expectClean(await audit(tab), `${name} ${tier} ${game}`);
        }
        await context.close();
        expect(errors).toEqual([]);
      }
    }, 120_000);

    it('a chosen model with a long name is shown in full under its dropdown (a closed select cannot wrap)', async () => {
      const { context, tab, errors } = await open(phone, 'match-create');
      await tab.selectOption('select[name="gameType"]', 'chess');
      await tab.waitForTimeout(150);
      const caption = tab.locator('[data-testid="selected-model"]').first();
      await tab.waitForFunction(() => (document.querySelector('[data-testid="selected-model"]') as HTMLElement | null)?.style.display === 'none'); // Alpine is up
      expect(await caption.isVisible()).toBe(false); // nothing chosen yet
      await tab.selectOption('select[name="model1Id"]', 'm1');
      await caption.waitFor({ state: 'visible' });
      const long = apiModels.find((m: any) => m.id === 'm1')!;
      expect(await caption.textContent()).toContain(long.name);
      expect(await tab.locator('select[name="model1Id"]').getAttribute('title')).toContain(long.name);
      const box = (await caption.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(phone.viewport.width);
      expect(box.height).toBeGreaterThan(16); // wrapped over several lines, not truncated
      // changing the choice updates it; clearing hides it
      await tab.selectOption('select[name="model1Id"]', 'm6');
      const other = apiModels.find((m: any) => m.id === 'm6')!.name;
      await tab.waitForFunction(name => document.querySelector('[data-testid="selected-model"]')?.textContent?.includes(name), other);
      await tab.selectOption('select[name="model1Id"]', '');
      await caption.waitFor({ state: 'hidden' }); // Alpine applies the change asynchronously
      await context.close();
      expect(errors).toEqual([]);
    }, 60_000);

    it.each(['match-chess', 'match-chutes', 'match-poker', 'match-poker6', 'match-blackjack', 'match-generic'])('%s replay stays clean while playing', async name => {
      const { context, tab, errors } = await open(phone, name);
      const next = tab.getByRole('button').filter({ has: tab.locator('path[d="m9 18 6-6-6-6"]') });
      const stages: number[] = [0, 2, 4, 20];
      let clicked = 0;
      for (const stage of stages) {
        while (clicked < stage && !(await next.isDisabled())) { await next.click(); clicked++; await tab.waitForTimeout(60); }
        await tab.waitForTimeout(250);
        await shot(tab, `${name}-step${stage}-${phone.name}`);
        expectClean(await audit(tab), `${name} step ${stage}`);
      }
      await context.close();
      expect(errors).toEqual([]);
    }, 90_000);

    it('the match page says in words whether the match is verified, unverified or failed, without overflowing', async () => {
      for (const [name, text, state] of [['match-chess', null, 'verified'], ['match-unverified', 'not a failure', 'unverified'], ['match-verification-failed', 'Do not rely on this replay', 'failed']] as Array<[string, string | null, string]>) {
        const { context, tab, errors } = await open(phone, name);
        const badges = await tab.locator(`[data-verification="${state}"]`).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { visible: r.width > 0 && r.height > 0, left: r.left, right: r.right }; }));
        expect(badges.some(b => b.visible && b.left >= 0 && b.right <= phone.viewport.width)).toBe(true); // a badge is on screen at this width
        if (text) {
          const notice = tab.locator('[data-testid="verification-notice"]');
          expect(await notice.isVisible()).toBe(true);
          expect(await notice.innerText()).toContain(text);
        } else {
          expect(await tab.locator('[data-testid="verification-notice"]').count()).toBe(0);
        }
        expectClean(await audit(tab), `${name} verification`);
        await context.close();
        expect(errors).toEqual([]);
      }
    }, 90_000);

    it('account settings: delete modal fits the screen', async () => {
      const { context, tab } = await open(phone, 'account-settings');
      await tab.getByRole('button', { name: 'Delete', exact: true }).click();
      await tab.waitForTimeout(250);
      const box = await tab.evaluate(() => {
        const modal = document.querySelector('.fixed.inset-0 > div') as HTMLElement;
        const r = modal.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight };
      });
      await tab.screenshot({ path: shots ? `${shots}/account-delete-modal-${phone.name}.png` : undefined });
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(box.w);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.h);
      const buttons = await tab.locator('.fixed.inset-0 button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.height), Math.round(r.right)]; }));
      for (const [h, right] of buttons) { expect(h).toBeGreaterThanOrEqual(44); expect(right).toBeLessThanOrEqual(phone.viewport.width); }
      await context.close();
    }, 60_000);
  });

  describe.each(LANDSCAPES)('landscape $name', phone => {
    it.each(['match-chess', 'match-chutes', 'match-poker', 'match-poker6', 'match-blackjack', 'match-generic'])('%s replay stays usable while playing', async name => {
      const { context, tab, errors } = await open(phone, name);
      const next = tab.getByRole('button').filter({ has: tab.locator('path[d="m9 18 6-6-6-6"]') });
      let clicked = 0;
      for (const stage of [0, 3, 20]) {
        while (clicked < stage && !(await next.isDisabled())) { await next.click(); clicked++; await tab.waitForTimeout(60); }
        await tab.waitForTimeout(250);
        await shot(tab, `${name}-landscape-step${stage}-${phone.name}`);
        expectClean(await audit(tab), `${name} landscape step ${stage}`);
      }
      // boards stay square (a max-height must never squash them) and chess pieces stay inside their squares
      if (name === 'match-chess' || name === 'match-chutes') {
        const board = (await tab.locator('#board-container > div').first().boundingBox())!;
        expect(Math.abs(board.width - board.height)).toBeLessThan(4);
        expect(board.height).toBeGreaterThan(150);
        expect(board.y + board.height).toBeLessThanOrEqual(phone.viewport.height + 600); // reachable by scrolling, nothing cut off
      }
      if (name === 'match-chess') {
        const fit = await tab.evaluate(() => {
          const span = document.querySelector('#board-container [x-html]') as HTMLElement;
          return { glyph: parseFloat(getComputedStyle(span).fontSize), square: span.parentElement!.getBoundingClientRect().width };
        });
        expect(fit.glyph).toBeLessThanOrEqual(fit.square);
      }
      // sticky chrome (site nav + replay toolbar) must leave most of a short screen for the match itself
      const chrome = await tab.evaluate(() => {
        let covered = 0;
        document.querySelectorAll('header, main *').forEach(el => {
          const s = getComputedStyle(el);
          if ((s.position === 'sticky' || s.position === 'fixed') && s.display !== 'none') {
            const r = el.getBoundingClientRect();
            if (r.width > window.innerWidth * 0.5 && r.top <= 1) covered = Math.max(covered, r.bottom);
          }
        });
        return { covered, height: window.innerHeight };
      });
      expect(chrome.covered / chrome.height).toBeLessThan(0.4);
      await context.close();
      expect(errors).toEqual([]);
    }, 90_000);

    it.each(['models-list', 'model-detail', 'match-create', 'account-settings'])('%s stays clean', async name => {
      const { context, tab, errors } = await open(phone, name);
      await shot(tab, `${name}-landscape-${phone.name}`);
      expectClean(await audit(tab), `${name} landscape`);
      await context.close();
      expect(errors).toEqual([]);
    }, 60_000);
  });

  it('desktop layouts are intact at 1280px', async () => {
    for (const name of ['match-create', 'match-chess', 'match-poker', 'match-blackjack', 'match-chutes', 'match-generic', 'models-list', 'model-detail', 'account-settings', 'mfa-setup-1']) {
      const { context, tab } = await open(PHONES[0], name, { desktop: true });
      expect(await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await shot(tab, `${name}-1280`);
      await context.close();
    }
  }, 120_000);
});
