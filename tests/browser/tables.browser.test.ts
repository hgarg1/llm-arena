/// <reference lib="dom" />
/**
 * Real-browser tests for tables and other data components on phones. Opt in with BROWSER_TESTS=1.
 * Renders the real EJS views (fixture data, real tailwind build) at 360x740 and 390x844 and checks that nothing
 * scrolls the page sideways, nothing is clipped off the right edge, the key text is visible and tap targets are 44px.
 * Set TABLE_SCREENSHOTS=<dir> to save full-page screenshots.
 */
import { Browser, chromium } from 'playwright-core';
import fs from 'fs';
import { auditPages, pages, startTablesSite } from './tables-harness';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const shots = process.env.TABLE_SCREENSHOTS;

const PHONES = [
  { name: '360x740', viewport: { width: 360, height: 740 } },
  { name: '390x844', viewport: { width: 390, height: 844 } }
];

/** Elements that must be comfortable to tap. Header/nav/aside have their own tests. */
const TAP_SELECTOR = [
  'main a.btn', 'main button', 'main select', 'main input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])',
  'footer a', 'table a', 'table button', '[data-testid="benchmarks-list"] a', '.scroll-strip button'
].join(',');

maybe('tables and data components on phones', () => {
  let site: Awaited<ReturnType<typeof startTablesSite>>;
  let browser: Browser;

  beforeAll(async () => {
    site = await startTablesSite();
    browser = await chromium.launch();
    if (shots) fs.mkdirSync(shots, { recursive: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await site?.close(); });

  describe.each(PHONES)('$name', phone => {
    it.each(Object.entries({ ...pages, ...auditPages }))('%s lays out cleanly', async (name, page) => {
      const context = await browser.newContext({ viewport: phone.viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const tab = await context.newPage();
      const errors: string[] = [];
      tab.on('pageerror', e => errors.push(e.message));
      const response = await tab.goto(`${site.base}/${name}`, { waitUntil: 'load' });
      expect(response!.status()).toBe(200);
      await tab.waitForTimeout(150);

      const report = await tab.evaluate(({ tapSelector }) => {
        const width = window.innerWidth;
        // an element is "contained" when an ancestor scrolls horizontally on purpose
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
          if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') return false;
          for (let p: Element | null = el; p; p = p.parentElement) { if (getComputedStyle(p).display === 'none') return false; }
          return true;
        };
        // the page itself, and the admin shell's own scroller
        const main = document.querySelector('main');
        const overflowPage = document.documentElement.scrollWidth - width;
        const overflowMain = main ? main.scrollWidth - main.clientWidth : 0;
        const clipped: string[] = [];
        document.querySelectorAll('body *').forEach(el => {
          if (el.classList.contains('site-nav__skip')) return;
          if (!visible(el) || el.closest('svg') || el.closest('thead')) return;
          if (el.closest('.pointer-events-none') || el.closest('[aria-hidden="true"]') || el.closest('aside') || el.closest('.sr-only') || el.closest('.site-nav__skip')) return;
          const r = el.getBoundingClientRect();
          if ((r.right > width + 1 || r.left < -1) && !insideScroller(el)) {
            clipped.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent || '').trim().slice(0, 30)}"`);
          }
        });
        const small: string[] = [];
        document.querySelectorAll(tapSelector).forEach(el => {
          if (!visible(el) || el.closest('aside') || el.closest('header') || el.closest('[x-show]') || el.closest('[style*="display: none"]')) return;
          const r = el.getBoundingClientRect();
          if (r.height < 43.5) small.push(`${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).placeholder || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        });
        // text that is too small to read (< 11px) anywhere visible and non-empty
        const tiny: string[] = [];
        document.querySelectorAll('body *').forEach(el => {
          if (!visible(el) || el.closest('aside')) return;
          const own = Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || '').trim().length > 2);
          if (own && parseFloat(getComputedStyle(el).fontSize) < 10.5) tiny.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 24)}" ${getComputedStyle(el).fontSize}`);
        });
        // every card-collapse cell must carry a label (or be a title, actions or empty-state cell) so nothing is anonymous
        const unlabeled: string[] = [];
        document.querySelectorAll('table.responsive-table tbody td').forEach(td => {
          if (td.hasAttribute('data-label') && td.getAttribute('data-label') !== '' ) return;
          if (td.classList.contains('rt-title') || td.classList.contains('rt-actions') || td.hasAttribute('colspan') || !(td.textContent || '').trim()) return;
          unlabeled.push((td.textContent || '').trim().slice(0, 24));
        });
        return { unlabeled, overflowPage, overflowMain, clipped: clipped.slice(0, 8), small: small.slice(0, 8), tiny: tiny.slice(0, 6), text: document.body.innerText };
      }, { tapSelector: TAP_SELECTOR });

      if (shots) await tab.screenshot({ path: `${shots}/${name}-${phone.name}.png`, fullPage: true });
      await context.close();

      expect(errors.filter(e => !/alpine|Alpine|x-data/i.test(e))).toEqual([]);
      expect(report.overflowPage).toBeLessThanOrEqual(0);
      expect(report.overflowMain).toBeLessThanOrEqual(0);
      expect(report.clipped).toEqual([]);
      expect(report.unlabeled).toEqual([]);
      for (const text of page.text) expect(report.text).toContain(text);
      expect(report.small).toEqual([]);
      expect(report.tiny).toEqual([]);
    }, 60_000);
  });

  it('home Latest Benchmarks shows a ranked list on phones and the table from md up', async () => {
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    await p.goto(`${site.base}/home`);
    expect(await p.locator('[data-testid="benchmarks-list"]').isVisible()).toBe(true);
    expect(await p.locator('#benchmarks table').isVisible()).toBe(false);
    expect(await p.locator('[data-testid="benchmarks-list"] li').count()).toBeGreaterThan(0);
    const heading = await p.locator('#benchmarks h2').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(heading).toBeLessThanOrEqual(32);
    await phone.close();

    const desktop = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    const d = await desktop.newPage();
    await d.goto(`${site.base}/home`);
    expect(await d.locator('#benchmarks table').isVisible()).toBe(true);
    expect(await d.locator('[data-testid="benchmarks-list"]').isVisible()).toBe(false);
    await desktop.close();
  }, 60_000);

  it('data-label tables stay real tables on desktop', async () => {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const d = await desktop.newPage();
    await d.goto(`${site.base}/benchmarks`);
    expect(await d.locator('table thead').isVisible()).toBe(true);
    const overflow = await d.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await desktop.close();
  }, 60_000);

  it('docs: phones get a tappable section strip that jumps to real sections; desktop keeps the sidebar', async () => {
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    await p.goto(`${site.base}/docs`);
    expect(await p.locator('aside').isVisible()).toBe(false);
    const strip = p.locator('nav[aria-label="On this page"]');
    expect(await strip.isVisible()).toBe(true);
    const links = strip.locator('a');
    expect(await links.count()).toBe(3);
    for (let i = 0; i < 3; i++) expect((await links.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // every link targets an element that exists
    for (const href of await links.evaluateAll(els => els.map(e => e.getAttribute('href')!))) expect(await p.locator(href).count()).toBe(1);
    await links.nth(2).tap();
    await p.waitForTimeout(400);
    const top = await p.locator('#replay-schema').evaluate(el => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(600); // in view (the page is short, so it cannot scroll the heading all the way up)
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await phone.close();

    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const d = await desktop.newPage();
    await d.goto(`${site.base}/docs`);
    expect(await d.locator('aside').isVisible()).toBe(true);
    expect(await d.locator('nav[aria-label="On this page"]').isVisible()).toBe(false);
    expect(await d.locator('aside a[href^="#"]').count()).toBe(3);
    await desktop.close();
  }, 60_000);
});
