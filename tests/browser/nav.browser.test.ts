/// <reference lib="dom" />
/**
 * Real-browser tests for the navigation. Opt in with BROWSER_TESTS=1 (needs `npx playwright-core install chromium`);
 * skipped otherwise so the default `npm test` needs no browser.
 */
import { Browser, BrowserContext, Page, chromium } from 'playwright-core';
import fs from 'fs';
import { startNavSite } from './nav-harness';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const shots = process.env.NAV_SCREENSHOTS;

const member = { email: 'archie@example.com', name: 'Archie Garg' };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const LAPTOP = { viewport: { width: 1440, height: 800 } };

maybe('navigation in a real browser', () => {
  let site: Awaited<ReturnType<typeof startNavSite>>;
  let mouse: Browser;      // fine pointer only: a normal desktop or laptop
  let touchLaptop: Browser; // fine + coarse pointers: a touch-screen laptop or desktop

  beforeAll(async () => {
    site = await startNavSite();
    mouse = await chromium.launch();
    touchLaptop = await chromium.launch({ args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=6'] });
  }, 120_000);
  afterAll(async () => { await mouse?.close(); await touchLaptop?.close(); await site?.close(); });

  const open = async (browser: Browser, options: Record<string, unknown>, viewer: Parameters<typeof site.as>[0] = {}) => {
    await site.as(viewer);
    const context: BrowserContext = await browser.newContext(options);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(site.base);
    await page.waitForFunction(() => (window as any).Alpine && document.querySelector('header.site-nav')?.hasAttribute('data-condensed'));
    return { page, context, errors };
  };
  const scrollTo = async (page: Page, y: number) => {
    await page.evaluate(top => window.scrollTo(0, top), y);
    await page.waitForTimeout(650); // rAF + the 400ms transition
  };
  const attr = (page: Page, name: string) => page.getAttribute('header.site-nav', name);
  const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
  const visible = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.5 && r.bottom > 0 && r.top < window.innerHeight;
  });
  const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }); } };

  describe('laptop / desktop with a mouse', () => {
    it('shows the full bar at the top, then morphs into the dock once scrolled, and back', async () => {
      const { page, context, errors } = await open(mouse, LAPTOP, { user: member, admin: true, unread: 2, path: '/benchmarks' });
      expect(await attr(page, 'data-condensed')).toBe('false');
      expect(await visible(page, '.site-nav__bar')).toBe(true);
      expect(await visible(page, '.site-nav__dock')).toBe(false);
      expect(await visible(page, '.site-nav__tabbar')).toBe(false);
      await shot(page, 'desktop-top');

      await scrollTo(page, 900);
      expect(await attr(page, 'data-condensed')).toBe('true');
      expect(await visible(page, '.site-nav__dock')).toBe(true);
      expect(await visible(page, '.site-nav__bar')).toBe(false);
      expect(await visible(page, '.site-nav__tabbar')).toBe(false);
      await shot(page, 'desktop-dock');

      await scrollTo(page, 0);
      expect(await attr(page, 'data-condensed')).toBe('false');
      expect(await visible(page, '.site-nav__bar')).toBe(true);
      expect(await visible(page, '.site-nav__dock')).toBe(false);
      expect(errors).toEqual([]);
      await context.close();
    });

    it('does not hide the hamburger-less bar: no menu button, no phone chrome on desktop', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      expect(await page.getByRole('button', { name: 'Open menu' }).isVisible()).toBe(false);
      expect(await page.getByRole('link', { name: 'Live matches' }).first().isVisible()).toBe(true);
      await context.close();
    });

    it('only the active surface is reachable: the hidden ones are inert', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      const inert = (selector: string) => page.locator(selector).first().evaluate(el => (el as HTMLElement).inert);
      expect([await inert('.site-nav__bar'), await inert('.site-nav__dock-wrap'), await inert('.site-nav__tabbar')]).toEqual([false, true, true]);
      await scrollTo(page, 900);
      expect([await inert('.site-nav__bar'), await inert('.site-nav__dock-wrap'), await inert('.site-nav__tabbar')]).toEqual([true, false, true]);
      await context.close();
    });

    it('does not flicker around the threshold (hysteresis)', async () => {
      const { page, context } = await open(mouse, LAPTOP);
      await scrollTo(page, 120);
      expect(await attr(page, 'data-condensed')).toBe('true');
      await scrollTo(page, 50);               // between the two thresholds: stays condensed
      expect(await attr(page, 'data-condensed')).toBe('true');
      await scrollTo(page, 10);
      expect(await attr(page, 'data-condensed')).toBe('false');
      await context.close();
    });

    it('never shifts the page layout when it morphs', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      const before = await page.evaluate(() => ({ nav: document.querySelector('header.site-nav')!.getBoundingClientRect().height, doc: document.documentElement.scrollHeight }));
      await scrollTo(page, 900);
      const after = await page.evaluate(() => ({ nav: document.querySelector('header.site-nav')!.getBoundingClientRect().height, doc: document.documentElement.scrollHeight }));
      expect(after).toEqual(before);
      await context.close();
    });

    it('account menu opens on click, closes on Escape and on an outside click, and signs out via POST', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member, admin: true });
      const trigger = page.locator('.site-nav__bar').getByRole('button', { name: /Account menu/ });
      await trigger.click();
      expect(await trigger.getAttribute('aria-expanded')).toBe('true');
      await page.locator('.site-nav__bar').getByRole('menuitem', { name: 'Admin console' }).waitFor({ state: 'visible' });
      expect(await page.locator('.site-nav__bar form[action="/auth/logout"]').getAttribute('method')).toBe('POST');
      await page.keyboard.press('Escape');
      expect(await trigger.getAttribute('aria-expanded')).toBe('false');
      await trigger.click();
      await page.mouse.click(300, 400);
      expect(await trigger.getAttribute('aria-expanded')).toBe('false');
      await context.close();
    });

    it('the dock has its own working account menu, independent of the top bar (regression: shared state closed the visible menu)', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member, admin: true });
      await scrollTo(page, 900);
      const trigger = page.locator('.site-nav__dock').getByRole('button', { name: /Account menu/ });
      await trigger.click();
      expect(await trigger.getAttribute('aria-expanded')).toBe('true');
      await page.locator('.site-nav__dock .site-nav__menu').waitFor({ state: 'visible' });
      await page.locator('.site-nav__dock').getByRole('menuitem', { name: 'Sign out' }).waitFor({ state: 'visible' });
      await shot(page, 'desktop-dock-menu');
      await page.keyboard.press('Escape');
      expect(await trigger.getAttribute('aria-expanded')).toBe('false');
      await context.close();
    });

    it('closes the account menu when the bar morphs (it would otherwise be stranded)', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      await page.locator('.site-nav__bar').getByRole('button', { name: /Account menu/ }).click();
      await page.locator('.site-nav__bar .site-nav__menu').waitFor({ state: 'visible' });
      await scrollTo(page, 900);
      expect(await page.locator('.site-nav__bar .site-nav__menu').isVisible()).toBe(false);
      await context.close();
    });

    it('the dock fits without overflow even at the narrowest desktop width (1024px) and signed out', async () => {
      for (const viewer of [{ user: member, admin: true, unread: 12 }, {}]) {
        const { page, context } = await open(mouse, { viewport: { width: 1024, height: 768 } }, viewer);
        await scrollTo(page, 900);
        const dock = await box(page, '.site-nav__dock');
        expect(dock.x).toBeGreaterThanOrEqual(0);
        expect(dock.x + dock.width).toBeLessThanOrEqual(1024);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await context.close();
      }
    });

    it('dock links are keyboard reachable with a visible focus ring', async () => {
      const { page, context } = await open(mouse, LAPTOP);
      await scrollTo(page, 900);
      await page.locator('.site-nav__dock-link').first().focus();
      const outline = await page.locator('.site-nav__dock-link').first().evaluate(el => getComputedStyle(el).outlineStyle);
      expect(outline).not.toBe('none');
      await context.close();
    });
  });

  describe('touch-screen laptop / desktop', () => {
    it('really reports a coarse pointer, and the dock grows to at least 48px targets', async () => {
      const { page, context } = await open(touchLaptop, { ...LAPTOP, hasTouch: true }, { user: member, unread: 1 });
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      await scrollTo(page, 900);
      for (const selector of ['.site-nav__dock-link', '.site-nav__dock-icon', '.site-nav__dock .site-nav__account']) {
        expect((await box(page, selector)).height).toBeGreaterThanOrEqual(48);
      }
      expect((await box(page, '.site-nav__dock-icon')).width).toBeGreaterThanOrEqual(48);
      await shot(page, 'touch-laptop-dock');
      await context.close();
    });

    it('a mouse laptop keeps the compact 40px dock', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      await scrollTo(page, 900);
      expect((await box(page, '.site-nav__dock-link')).height).toBeLessThan(48);
      await context.close();
    });

    it('menus open by tap (no hover needed) and the top bar also uses 44px targets', async () => {
      const { page, context } = await open(touchLaptop, { ...LAPTOP, hasTouch: true }, { user: member });
      expect((await box(page, '.site-nav__bar .site-nav__link')).height).toBeGreaterThanOrEqual(44);
      await page.locator('.site-nav__bar').getByRole('button', { name: /Account menu/ }).tap();
      await page.locator('.site-nav__bar .site-nav__menu').waitFor({ state: 'visible' });
      expect((await box(page, '.site-nav__bar .site-nav__menu-item')).height).toBeGreaterThanOrEqual(48);
      await context.close();
    });
  });

  describe('phone', () => {
    it('shows a slim top bar with brand and menu only, and no tab bar, at the top', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, unread: 3, path: '/matches' });
      expect(await visible(page, '.site-nav__bar')).toBe(true);
      expect(await visible(page, '.site-nav__tabbar')).toBe(false);
      expect(await page.getByRole('link', { name: 'Live matches' }).first().isVisible()).toBe(false);
      expect(await page.locator('.site-nav__bar .site-nav__brand').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(60); // brand does not wrap
      await shot(page, 'phone-top');
      await context.close();
    });

    it('morphs into a bottom tab bar when scrolled; top bar slides away going down and returns going up', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, unread: 3, path: '/matches' });
      await scrollTo(page, 100);
      expect(await attr(page, 'data-condensed')).toBe('true');
      await scrollTo(page, 700);
      expect(await visible(page, '.site-nav__tabbar')).toBe(true);
      expect(await attr(page, 'data-hidden')).toBe('true');
      expect(await visible(page, '.site-nav__bar')).toBe(false);
      await shot(page, 'phone-tabbar');
      await scrollTo(page, 560);
      expect(await attr(page, 'data-hidden')).toBe('false');
      expect(await visible(page, '.site-nav__bar')).toBe(true);
      expect(await visible(page, '.site-nav__tabbar')).toBe(true);
      await scrollTo(page, 0);
      expect(await visible(page, '.site-nav__tabbar')).toBe(false);
      await context.close();
    });

    it('tab bar sits at the bottom edge, spans the screen, and every target is at least 44px', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, unread: 3 });
      await scrollTo(page, 700);
      const bar = await box(page, '.site-nav__tabbar');
      expect(Math.round(bar.y + bar.height)).toBe(844);
      expect(Math.round(bar.width)).toBe(390);
      const tabs = page.locator('.site-nav__tab');
      expect(await tabs.count()).toBe(5);
      for (let i = 0; i < 5; i++) {
        const b = (await tabs.nth(i).boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.width).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    it('marks the current tab and shows the unread badge', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, unread: 3, path: '/matches' });
      await scrollTo(page, 700);
      expect(await page.locator('.site-nav__tab[aria-current="page"]').innerText()).toContain('Matches');
      expect(await page.locator('.site-nav__tab', { hasText: 'Chat' }).locator('.site-nav__badge').innerText()).toBe('3');
      await context.close();
    });

    it('signed-out visitors get a Docs tab instead of Chat', async () => {
      const { page, context } = await open(mouse, PHONE, {});
      await scrollTo(page, 700);
      expect(await page.locator('.site-nav__tab', { hasText: 'Docs' }).count()).toBe(1);
      expect(await page.locator('.site-nav__tab', { hasText: 'Chat' }).count()).toBe(0);
      await context.close();
    });

    it('Menu opens a modal sheet: focus moves in, the page cannot scroll, Escape closes and focus returns', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, unread: 3 });
      await scrollTo(page, 700);
      const menuTab = page.getByRole('button', { name: 'Menu', exact: true });
      await menuTab.click();
      await page.waitForTimeout(500);
      const dialog = page.getByRole('dialog', { name: 'Menu' });
      expect(await dialog.isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
      await shot(page, 'phone-sheet');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      expect(await dialog.isVisible()).toBe(false);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
      expect(await page.evaluate(() => document.activeElement?.textContent?.includes('Menu'))).toBe(true);
      await context.close();
    });

    it('keeps keyboard focus inside the open sheet (focus trap) and closes on a backdrop tap', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.waitForTimeout(500);
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      }
      await page.locator('.site-nav__backdrop').click({ position: { x: 195, y: 20 } });
      await page.waitForTimeout(500);
      expect(await page.getByRole('dialog', { name: 'Menu' }).isVisible()).toBe(false);
      await context.close();
    });

    it('sheet rows are at least 48px tall and include every destination plus sign out', async () => {
      const { page, context } = await open(mouse, PHONE, { user: member, admin: true });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.waitForTimeout(500);
      const rows = page.locator('.site-nav__sheet-link');
      const count = await rows.count();
      expect(count).toBeGreaterThanOrEqual(10);
      for (let i = 0; i < count; i++) expect((await rows.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(48);
      const text = (await page.locator('.site-nav__sheet').innerText()).replace(/\s+/g, ' ');
      for (const label of ['Live matches', 'How It Works', 'Benchmarks', 'Methodology', 'Use Cases', 'About', 'Docs', 'Chat', 'Account', 'Admin console', 'Sign out']) {
        expect(text).toContain(label);
      }
      await context.close();
    });

    it('rotating to a laptop-size viewport closes the sheet and switches to the desktop navigation', async () => {
      const { page, context } = await open(mouse, { viewport: { width: 700, height: 800 } }, { user: member });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(500);
      expect(await page.getByRole('dialog', { name: 'Menu' }).isVisible()).toBe(false);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
      await context.close();
    });

    it('no horizontal overflow on very small phones (320px) in any state', async () => {
      const { page, context } = await open(mouse, { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }, { user: member, unread: 12 });
      for (const y of [0, 700]) {
        await scrollTo(page, y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await context.close();
    });
  });

  describe('accessibility', () => {
    it('the skip link is the first tab stop, becomes visible on focus, and moves focus to the main content', async () => {
      const { page, context } = await open(mouse, LAPTOP);
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to content' });
      expect(await skip.evaluate(el => el === document.activeElement)).toBe(true);
      expect((await skip.boundingBox())!.x).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('main-content');
      await context.close();
    });

    it('with reduced motion requested the morph is instant (no transitions)', async () => {
      const { page, context } = await open(mouse, { ...LAPTOP, reducedMotion: 'reduce' }, { user: member });
      const durations = await page.evaluate(() => ['.site-nav__bar', '.site-nav__dock'].map(s => getComputedStyle(document.querySelector(s)!).transitionDuration));
      expect(durations.every(d => d.split(',').every(x => parseFloat(x) === 0))).toBe(true);
      await scrollTo(page, 900);
      expect(await visible(page, '.site-nav__dock')).toBe(true);
      await context.close();
    });

    it('with normal motion the morph does animate', async () => {
      const { page, context } = await open(mouse, LAPTOP, { user: member });
      const duration = await page.evaluate(() => getComputedStyle(document.querySelector('.site-nav__dock')!).transitionDuration);
      expect(parseFloat(duration.split(',')[0])).toBeGreaterThan(0.2);
      await context.close();
    });

    it('survives a script error elsewhere on the page: the top bar still works without the morph', async () => {
      const { page, context, errors } = await open(mouse, LAPTOP, { user: member });
      expect(errors).toEqual([]);
      expect(await page.getByRole('link', { name: 'Benchmarks' }).first().isVisible()).toBe(true);
      await context.close();
    });
  });
});
