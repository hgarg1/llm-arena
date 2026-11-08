/// <reference lib="dom" />
/**
 * Real-browser tests for the session watcher. Opt in with BROWSER_TESTS=1 (needs `npx playwright-core install chromium`).
 * Set SESSION_SCREENSHOTS=<dir> to also save screenshots of each moment of the animation.
 */
import { Browser, BrowserContext, Page, chromium } from 'playwright-core';
import fs from 'fs';
import { startSessionSite } from './session-harness';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const shots = process.env.SESSION_SCREENSHOTS;

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const LAPTOP = { viewport: { width: 1280, height: 800 } };

maybe('session watcher in a real browser', () => {
  let site: Awaited<ReturnType<typeof startSessionSite>>;
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => { site = await startSessionSite(); browser = await chromium.launch(); }, 120_000);
  afterAll(async () => { await browser?.close(); await site?.close(); });
  afterEach(async () => { while (contexts.length) await contexts.pop()!.close(); });

  const setState = (patch: object) => fetch(`${site.base}/__state?${encodeURIComponent(JSON.stringify(patch))}`);
  const open = async (pathname: string, options: Record<string, unknown> = LAPTOP) => {
    await setState({ signedIn: true, statusMode: 'ok', polls: 0, pageLoads: 0, loginRequests: [] });
    const context = await browser.newContext(options);
    contexts.push(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(site.base + pathname);
    await page.waitForFunction(() => (window as any).Alpine && (window as any).__sessionWatchStarted);
    return { page, context, errors };
  };
  const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }); } };
  const toast = (page: Page) => page.locator('.sw-toast');
  const navHasAccountMenu = (page: Page) => page.locator('.site-nav__account').count();
  const focusTab = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

  describe('on a public page', () => {
    it('turns into the signed-out version in place, with the animation, without reloading', async () => {
      const { page, errors } = await open('/benchmarks');
      expect(await navHasAccountMenu(page)).toBeGreaterThan(0);
      await page.evaluate(() => { (window as any).__marker = 'same-document'; });
      const loadsBefore = site.state.pageLoads;

      await setState({ signedIn: false });
      await focusTab(page);

      await toast(page).waitFor({ state: 'visible' });
      expect(await toast(page).getAttribute('data-state')).toBe('ending');
      await page.waitForTimeout(500);
      await shot(page, 'desktop-1-ending');

      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      await page.waitForTimeout(700);
      await shot(page, 'desktop-2-signed-out');

      expect(await page.evaluate(() => (window as any).__marker)).toBe('same-document'); // no navigation happened
      expect(site.state.pageLoads).toBe(loadsBefore + 1); // exactly one extra fetch of the page for the swap
      expect(await navHasAccountMenu(page)).toBe(0);
      expect(await page.locator('text=Welcome, visitor').count()).toBe(1);
      expect(await page.title()).toContain('Signed-out page');
      expect(await page.getAttribute('meta[name="csrf-token"]', 'content')).toBe('csrf-anonymous');
      expect(await page.locator('a[href="/auth/login"]').count()).toBeGreaterThan(0);
      expect(await page.locator('.sw-action').getAttribute('href')).toBe('/auth/login?next=%2Fbenchmarks');
      expect(await page.locator('.sw-title').textContent()).toBe('You’ve been signed out');
      expect(errors).toEqual([]);
    });

    it('stops watching afterwards (no more polling once signed out)', async () => {
      const { page } = await open('/benchmarks');
      await setState({ signedIn: false });
      await focusTab(page);
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      const polls = site.state.polls;
      for (let i = 0; i < 3; i++) { await focusTab(page); await page.waitForTimeout(300); }
      expect(site.state.polls).toBe(polls);
    });

    it('the signed-out page remains interactive (Alpine re-initialised): the mobile menu opens', async () => {
      const { page } = await open('/benchmarks', PHONE);
      await setState({ signedIn: false });
      await focusTab(page);
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      await page.locator('.sw-close').click();
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.locator('.site-nav__sheet[role="dialog"]').waitFor({ state: 'visible', timeout: 5000 });
      // the sheet now belongs to the signed-out page: sign in / get started, no account entry
      expect(await page.locator('.site-nav__sheet a[href="/account"]').count()).toBe(0);
      expect(await page.locator('.site-nav__sheet a[href="/auth/login"]').count()).toBeGreaterThan(0);
    });

    it('the dismiss button hides the notice', async () => {
      const { page } = await open('/benchmarks');
      await setState({ signedIn: false });
      await focusTab(page);
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      await page.locator('.sw-close').click();
      await toast(page).waitFor({ state: 'hidden' });
    });
  });

  describe('on a protected page', () => {
    it('shows the transition, then sends the visitor to sign in with a way back', async () => {
      const { page } = await open('/account');
      await setState({ signedIn: false });
      await focusTab(page);

      await toast(page).waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('.sw-veil')?.classList.contains('is-on'));
      await shot(page, 'desktop-3-redirecting');
      await page.waitForURL(/\/auth\/login/);
      expect(new URL(page.url()).searchParams.get('next')).toBe('/account');
      expect(await page.locator('#page-title').textContent()).toBe('Sign in');
    });
  });

  describe('triggers', () => {
    it('notices on its own timer without any user action', async () => {
      const { page } = await open('/benchmarks');
      await page.waitForTimeout(100);
      await setState({ signedIn: false });
      // The first poll fires ~1.5-3s after load, sees the logout and starts the transition.
      await toast(page).waitFor({ state: 'visible', timeout: 15_000 });
      expect(site.state.polls).toBeGreaterThan(0);
    });

    it('a 401 from the app\'s own request triggers an immediate check', async () => {
      const { page } = await open('/benchmarks');
      await page.waitForTimeout(3500); // let the first scheduled poll pass so the next one is far away
      await setState({ signedIn: false });
      const polls = site.state.polls;
      await page.evaluate(() => fetch('/api/protected'));
      await toast(page).waitFor({ state: 'visible', timeout: 5000 });
      expect(site.state.polls).toBeGreaterThan(polls);
    });

    it('signing out in one tab updates the other tab', async () => {
      const { page, context } = await open('/benchmarks');
      const other = await context.newPage();
      await other.goto(site.base + '/benchmarks');
      await other.waitForFunction(() => (window as any).__sessionWatchStarted);
      await setState({ signedIn: false });
      await other.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('.sw-toast').waitFor({ state: 'visible', timeout: 8000 });
      await other.close();
    });
  });

  describe('outages are not logouts', () => {
    for (const mode of ['down', 'drop', 'garbage'] as const) {
      it(`a ${mode} status endpoint never signs anyone out`, async () => {
        const { page, errors } = await open('/benchmarks');
        await setState({ statusMode: mode });
        const polls = site.state.polls;
        await focusTab(page);
        await page.waitForTimeout(1200);
        expect(site.state.polls).toBeGreaterThan(polls);
        expect(await toast(page).count()).toBe(0);
        expect(await navHasAccountMenu(page)).toBeGreaterThan(0);
        // ...and it recovers: a real logout afterwards is still detected.
        await setState({ statusMode: 'ok', signedIn: false });
        await page.waitForTimeout(4200); // clear the minimum gap between checks
        await focusTab(page);
        await toast(page).waitFor({ state: 'visible', timeout: 8000 });
        expect(errors).toEqual([]);
      });
    }
  });

  describe('accessibility and motion', () => {
    it('announces politely and, with reduced motion, still completes without animations', async () => {
      const { page } = await open('/benchmarks', { ...LAPTOP, reducedMotion: 'reduce' });
      await setState({ signedIn: false });
      await focusTab(page);
      await toast(page).waitFor({ state: 'visible' });
      expect(await toast(page).getAttribute('role')).toBe('status');
      expect(await toast(page).getAttribute('aria-live')).toBe('polite');
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      const animations = await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSAnimation && (a.effect as any)?.target?.closest?.('.sw-toast') && a.playState === 'running').length);
      expect(animations).toBe(0);
      expect(await toast(page).evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    });

    it('the notice is reachable and operable by keyboard', async () => {
      const { page } = await open('/benchmarks');
      await setState({ signedIn: false });
      await focusTab(page);
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      await page.locator('.sw-action').focus();
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('sw-action');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('sw-close');
      await page.keyboard.press('Enter');
      await toast(page).waitFor({ state: 'hidden' });
    });
  });

  describe('phone layout', () => {
    it('keeps the notice above the tab bar with full-width, touch-sized actions', async () => {
      const { page } = await open('/benchmarks', PHONE);
      await setState({ signedIn: false });
      await focusTab(page);
      await page.waitForTimeout(600);
      await shot(page, 'phone-1-ending');
      await page.waitForFunction(() => document.querySelector('.sw-toast')?.getAttribute('data-state') === 'done');
      await page.waitForTimeout(800);
      await shot(page, 'phone-2-signed-out');

      const t = (await toast(page).boundingBox())!;
      const tab = (await page.locator('.site-nav__tabbar').boundingBox())!;
      expect(t.y + t.height).toBeLessThanOrEqual(tab.y);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(390);
      const action = (await page.locator('.sw-action').boundingBox())!;
      const close = (await page.locator('.sw-close').boundingBox())!;
      expect(action.height).toBeGreaterThanOrEqual(44);
      expect(close.width).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
});
