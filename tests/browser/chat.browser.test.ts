/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Real-browser tests for the chat page. Opt in with BROWSER_TESTS=1 (needs `npx playwright-core install chromium`);
 * skipped otherwise so the default `npm test` needs no browser.
 */
import { Browser, BrowserContext, Page, chromium } from 'playwright-core';
import fs from 'fs';
import { startChatSite, ChatScenario } from './chat-harness';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const shots = process.env.CHAT_SCREENSHOTS;

const phone = (width = 390, height = 844) => ({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const DESKTOP = { viewport: { width: 1440, height: 800 } };
const PHONE_WIDTHS = [320, 375, 390, 430];

maybe('chat in a real browser', () => {
  let site: Awaited<ReturnType<typeof startChatSite>>;
  let browser: Browser;

  beforeAll(async () => {
    site = await startChatSite();
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); await site?.close(); });

  const open = async (url: string, options: Record<string, unknown>, scenario: ChatScenario = {}) => {
    await site.scenario(scenario);
    const context: BrowserContext = await browser.newContext(options);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('dialog', d => d.dismiss());
    await page.goto(site.base + url);
    await page.waitForFunction(() => (window as any).Alpine && (window as any).marked && (window as any).DOMPurify && document.querySelector('.chat-shell'));
    return { page, context, errors };
  };
  const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
  const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
  const shot = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }); } };
  const atBottom = (page: Page) => page.evaluate(() => { const m = document.getElementById('messages-container')!; return m.scrollHeight - m.scrollTop - m.clientHeight < 4; });

  describe.each(PHONE_WIDTHS)('phone, %ipx wide', width => {
    it('shows the conversation list as the whole screen: no overflow, no page scroll, thread hidden', async () => {
      const { page, context, errors } = await open('/chat', phone(width));
      expect(await page.locator('.chat-shell').getAttribute('data-view')).toBe('list');
      expect(await noOverflow(page)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true); // the app shell never scrolls the page
      expect(await page.locator('.chat-list').isVisible()).toBe(true);
      expect(await page.locator('.chat-thread').isVisible()).toBe(false);
      expect(Math.round((await box(page, '.chat-list')).width)).toBe(width);
      if (width === 390) await shot(page, 'phone-list');
      expect(errors).toEqual([]);
      await context.close();
    });

    it('list rows and header buttons are at least 44px, and long names truncate instead of widening the page', async () => {
      const { page, context } = await open('/chat', phone(width));
      const rows = page.locator('.chat-list-item');
      for (let i = 0; i < Math.min(await rows.count(), 8); i++) expect((await rows.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      for (const label of ['New direct message', 'Create channel']) {
        const b = (await page.getByRole('button', { name: label }).boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });

    it('the list scrolls inside the shell, not the page', async () => {
      const { page, context } = await open('/chat', phone(width), { channels: 60 });
      const scrolled = await page.locator('.chat-list nav').evaluate(el => { el.scrollTop = 500; return { top: el.scrollTop, can: el.scrollHeight > el.clientHeight }; });
      expect(scrolled.can).toBe(true);
      expect(scrolled.top).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await context.close();
    });

    it('a thread fills the screen with a sized back button, no overflow, and the composer inside the viewport', async () => {
      const { page, context, errors } = await open('/chat/channels/ch-1', phone(width));
      expect(await page.locator('.chat-shell').getAttribute('data-view')).toBe('thread');
      expect(await noOverflow(page)).toBe(true);
      expect(await page.locator('.chat-list').isVisible()).toBe(false);
      const back = await box(page, '.chat-back');
      expect(back.width).toBeGreaterThanOrEqual(44);
      expect(back.height).toBeGreaterThanOrEqual(44);
      const composer = await box(page, '.chat-composer');
      expect(composer.y + composer.height).toBeLessThanOrEqual(844 + 0.5);
      expect(Math.round(composer.y + composer.height)).toBe(844);        // pinned to the bottom edge
      expect(await page.locator('.site-nav__tabbar').evaluate(el => getComputedStyle(el).visibility)).toBe('hidden'); // nothing overlaps the composer
      expect(errors).toEqual([]);
      if (width === 390) await shot(page, 'phone-thread');
      await context.close();
    });

    it('long URLs, long words, code, tables, images and long file names stay inside the screen', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(width), { messages: 40 });
      expect(await noOverflow(page)).toBe(true);
      const overflowing = await page.evaluate(() => {
        const container = document.getElementById('messages-container')!;
        const limit = container.getBoundingClientRect().right + 1;
        return [...container.querySelectorAll('*')]
          .filter(el => !el.closest('pre') && !el.closest('table') && !(el as HTMLElement).closest('.markdown-body table'))
          .filter(el => el.getBoundingClientRect().right > limit && el.getBoundingClientRect().width > 0)
          .map(el => el.tagName + '.' + (el as HTMLElement).className.toString().slice(0, 40));
      });
      expect(overflowing).toEqual([]);
      // wide content scrolls inside its own box
      expect(await page.evaluate(() => [...document.querySelectorAll('.markdown-body pre')].every(p => getComputedStyle(p).overflowX === 'auto'))).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll('.markdown-body table')].every(t => getComputedStyle(t).overflowX === 'auto' && t.getBoundingClientRect().right <= window.innerWidth))).toBe(true);
      await context.close();
    });

    it('opens scrolled to the latest message', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(width), { messages: 60 });
      await page.waitForTimeout(300);
      expect(await atBottom(page)).toBe(true);
      await context.close();
    });
  });

  describe('thread behaviour on a phone', () => {
    it('tapping a conversation opens it, and the back button and the browser back gesture both return to the list', async () => {
      const { page, context } = await open('/chat', phone());
      await page.locator('.chat-list-item').first().tap();
      await page.waitForURL('**/chat/channels/ch-1');
      expect(await page.locator('.chat-shell').getAttribute('data-view')).toBe('thread');
      await page.goBack();                       // the system back gesture
      await page.waitForURL('**/chat');
      expect(await page.locator('.chat-shell').getAttribute('data-view')).toBe('list');
      await page.locator('.chat-list-item').nth(2).tap();
      await page.waitForURL('**/chat/channels/ch-3');
      await page.getByRole('link', { name: 'Back to conversations' }).tap();
      await page.waitForURL('**/chat');
      expect(await page.locator('.chat-shell').getAttribute('data-view')).toBe('list');
      await context.close();
    });

    it('does not steal focus on load (the keyboard must not cover the thread), and the composer is a 16px input', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone());
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('message-input');
      expect(await page.locator('#message-input').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await context.close();
    });

    it('send and attach buttons are at least 44px; the short placeholder is not clipped', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(320));
      for (const selector of ['.chat-send', '[aria-label="Attach file"]']) {
        const b = await box(page, selector);
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.locator('#message-input').evaluate(el => (el as HTMLTextAreaElement).placeholder)).toBe('Message…');
      expect(await page.locator('#message-input').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await context.close();
    });

    it('Enter inserts a new line on a phone; the Send button sends with the CSRF token and resets the composer', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone());
      const input = page.locator('#message-input');
      await input.tap();
      await input.pressSequentially('first line');
      await page.keyboard.press('Enter');
      await input.pressSequentially('second line');
      expect(await input.inputValue()).toBe('first line\nsecond line');
      expect(await site.posts()).toHaveLength(0);
      const grown = await input.evaluate(el => el.getBoundingClientRect().height);
      expect(grown).toBeGreaterThan(50);                                   // it grew with the text
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('.chat-send').tap()]);
      const posts = await site.posts();
      expect(posts).toHaveLength(1);
      expect(posts[0].csrf).toBe('test-token');
      expect(posts[0].contentType).toContain('multipart/form-data');
      await context.close();
    });

    it('edit and delete are visible without hovering, and at least 44px', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone());
      const actions = page.locator('.chat-actions').first();
      expect(await actions.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
      for (const name of ['Edit message', 'Delete message']) {
        const b = (await page.getByRole('button', { name }).first().boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      await context.close();
    });

    it('editing escapes hostile content: it is shown as text in the box, never injected as markup', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(), { xss: true });
      await page.locator('#msg-m-xss').getByRole('button', { name: 'Edit message' }).tap();
      const edit = page.locator('#edit-input-m-xss');
      await edit.waitFor();
      expect(await edit.inputValue()).toBe('</textarea><b id="pwn">pwn</b>');
      expect(await page.locator('#pwn').count()).toBe(0);
      expect(await edit.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await context.close();
    });

    it('jump-to-latest: hidden at the bottom; appears when new content arrives while reading older messages; returns to the bottom', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(), { messages: 60 });
      await page.waitForTimeout(300);
      expect(await page.locator('#jump-latest').isHidden()).toBe(true);
      await page.locator('#messages-container').evaluate(el => { el.scrollTop = 0; });
      await page.waitForTimeout(200);
      await page.evaluate(() => (window as any).scrollToBottom());           // a new message arrives (not forced)
      expect(await page.locator('#jump-latest').isVisible()).toBe(true);
      expect(await atBottom(page)).toBe(false);                              // the reader was not yanked away
      const b = await box(page, '#jump-latest');
      expect(b.width).toBeGreaterThanOrEqual(44);
      await page.locator('#jump-latest').tap();
      await page.waitForTimeout(400);
      expect(await atBottom(page)).toBe(true);
      expect(await page.locator('#jump-latest').isHidden()).toBe(true);
      await context.close();
    });

    it('the composer follows the visual viewport when the on-screen keyboard opens (simulated), and recovers', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(390, 844));
      const setVisual = (height: number, offsetTop = 0) => page.evaluate(([h, t]) => {
        const vv = window.visualViewport as any;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => t });
        vv.dispatchEvent(new Event('resize'));
      }, [height, offsetTop]);
      await setVisual(844 - 336);                                           // keyboard takes 336px
      await page.waitForTimeout(100);
      const composer = await box(page, '.chat-composer');
      expect(Math.round(composer.y + composer.height)).toBe(508);          // sits right above the keyboard
      const header = await box(page, '.chat-header');
      expect(header.y).toBeGreaterThanOrEqual(56 - 1);                     // still below the site header
      expect((await box(page, '#messages-container')).height).toBeGreaterThan(100);
      await setVisual(844);
      await page.waitForTimeout(100);
      const restored = await box(page, '.chat-composer');
      expect(Math.round(restored.y + restored.height)).toBe(844);
      await context.close();
    });

    it('survives iOS-style viewport scrolling (offsetTop > 0) without leaving a gap or hiding the header', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(390, 844));
      await page.evaluate(() => {
        const vv = window.visualViewport as any;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => 500 });
        Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => 120 });
        vv.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(100);
      const shell = await box(page, '.chat-shell');
      expect(Math.round(shell.y)).toBe(120);                                 // starts at the top of what is visible
      expect(Math.round(shell.y + shell.height)).toBe(620);                  // ends where the keyboard begins
      await context.close();
    });

    it('works in landscape: the composer stays visible and the messages keep usable height', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(844, 390));
      expect(await noOverflow(page)).toBe(true);
      const composer = await box(page, '.chat-composer');
      expect(composer.y + composer.height).toBeLessThanOrEqual(390.5);
      expect((await box(page, '#messages-container')).height).toBeGreaterThan(90);
      await context.close();
    });

    it('read-only channels and maintenance mode show their notice and no composer, without overflow', async () => {
      for (const scenario of [{ readOnly: true }, { maintenance: true }] as ChatScenario[]) {
        const { page, context } = await open('/chat/channels/ch-1', phone(320), scenario);
        expect(await page.locator('#chat-form').count()).toBe(0);
        expect(await page.locator('.chat-composer').innerText()).toMatch(/read-only|maintenance/);
        expect(await noOverflow(page)).toBe(true);
        await context.close();
      }
    });

    it('an empty thread and an error banner fit a 320px screen', async () => {
      const { page, context } = await open('/chat/channels/ch-1', phone(320), { empty: true, errorBanner: 'Could not send that message. Please try again in a moment.' });
      expect(await page.locator('#empty-state').isVisible()).toBe(true);
      expect(await page.getByRole('alert').isVisible()).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });
  });

  describe('modals on a phone', () => {
    it('"Create channel" opens as a bottom sheet that fits the screen, focuses its first field, and Escape closes it and restores focus', async () => {
      const { page, context } = await open('/chat', phone());
      const trigger = page.getByRole('button', { name: 'Create channel' });
      await trigger.tap();
      const dialog = page.getByRole('dialog', { name: 'Create New Channel' });
      await dialog.waitFor({ state: 'visible' });
      const card = await box(page, '#create-channel-modal > div');
      expect(Math.round(card.width)).toBe(390);
      expect(card.y + card.height).toBeLessThanOrEqual(844 + 0.5);
      expect(Math.round(card.y + card.height)).toBe(844);                  // anchored to the bottom
      await page.waitForTimeout(50);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('name');
      for (const selector of ['#create-channel-modal input[name="name"]', '#create-channel-modal select']) {
        const el = page.locator(selector);
        expect(await el.evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
        expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      expect((await box(page, '#create-channel-modal .chat-modal-close')).width).toBeGreaterThanOrEqual(44);
      await shot(page, 'phone-modal');
      await page.keyboard.press('Escape');
      expect(await dialog.isHidden()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Create channel');
      await context.close();
    });

    it('tapping the dimmed backdrop closes a modal; tapping inside it does not', async () => {
      const { page, context } = await open('/chat', phone());
      await page.getByRole('button', { name: 'Create channel' }).tap();
      await page.getByRole('dialog', { name: 'Create New Channel' }).waitFor({ state: 'visible' });
      await page.locator('#create-channel-modal h3').tap();
      expect(await page.locator('#create-channel-modal').isVisible()).toBe(true);
      await page.touchscreen.tap(195, 40);                                   // the backdrop above the sheet
      expect(await page.locator('#create-channel-modal').isHidden()).toBe(true);
      await context.close();
    });

    it('direct-message search works from the welcome screen, renders results as text (no injected markup) in sized rows', async () => {
      const { page, context } = await open('/chat', phone());
      await page.getByRole('button', { name: 'New direct message' }).tap();
      await page.getByRole('dialog', { name: 'Start Direct Message' }).waitFor({ state: 'visible' });
      await page.locator('#dm-search').pressSequentially('ev');
      const row = page.locator('.chat-dm-candidate').first();
      await row.waitFor({ timeout: 5000 });
      expect(await page.locator('#dm-candidates img[src="x"]').count()).toBe(0);   // the hostile name did not become an element
      expect(await row.innerText()).toContain('<img src=x onerror=alert(1)>Eve');
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });
  });

  describe('desktop (>= 1024px) keeps its two-pane layout', () => {
    it('shows list and thread together, with the original 18rem sidebar and no back button', async () => {
      const { page, context, errors } = await open('/chat/channels/ch-1', DESKTOP);
      expect(await page.locator('.chat-list').isVisible()).toBe(true);
      expect(await page.locator('.chat-thread').isVisible()).toBe(true);
      expect(Math.round((await box(page, '.chat-list')).width)).toBe(288);
      expect(await page.locator('.chat-back').isVisible()).toBe(false);
      expect(await noOverflow(page)).toBe(true);
      expect(errors).toEqual([]);
      await shot(page, 'desktop-thread');
      await context.close();
    });

    it('the welcome screen shows the list beside it', async () => {
      const { page, context } = await open('/chat', DESKTOP);
      expect(await page.locator('.chat-list').isVisible()).toBe(true);
      expect(await page.getByText('Welcome to Team Chat').isVisible()).toBe(true);
      await shot(page, 'desktop-list');
      await context.close();
    });

    it('the breakpoint is exactly 1024px: 1023px is single-pane, 1024px is two-pane', async () => {
      const narrow = await open('/chat/channels/ch-1', { viewport: { width: 1023, height: 800 } });
      expect(await narrow.page.locator('.chat-list').isVisible()).toBe(false);
      await narrow.context.close();
      const wide = await open('/chat/channels/ch-1', { viewport: { width: 1024, height: 800 } });
      expect(await wide.page.locator('.chat-list').isVisible()).toBe(true);
      expect(await noOverflow(wide.page)).toBe(true);
      await wide.context.close();
    });

    it('tablet portrait (768px) uses the single-pane layout without overflow', async () => {
      const { page, context } = await open('/chat/channels/ch-1', { viewport: { width: 768, height: 1024 }, hasTouch: true });
      expect(await page.locator('.chat-list').isVisible()).toBe(false);
      expect(await noOverflow(page)).toBe(true);
      await context.close();
    });

    it('edit/delete stay hidden until you hover or focus a message with a mouse', async () => {
      const { page, context } = await open('/chat/channels/ch-1', DESKTOP);
      const actions = page.locator('.chat-actions').first();
      const message = page.locator('.chat-msg', { has: actions }).first();
      await message.scrollIntoViewIfNeeded();
      expect(await actions.evaluate(el => getComputedStyle(el).opacity)).toBe('0');
      await message.hover();
      // the fade is a CSS transition: wait for it to finish instead of sleeping a fixed time (flaky under load)
      const settled = async () => {
        const handle = await actions.elementHandle();
        await page.waitForFunction(el => getComputedStyle(el as Element).opacity === '1', handle, { timeout: 5000 });
      };
      await settled();
      await page.mouse.move(5, 5);
      await actions.getByRole('button', { name: 'Edit message' }).focus();    // keyboard users reach it too
      await settled();
      await context.close();
    });

    it('Enter sends and Shift+Enter inserts a new line; the textarea is focused on load', async () => {
      const { page, context } = await open('/chat/channels/ch-1', DESKTOP);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('message-input');
      const input = page.locator('#message-input');
      await input.pressSequentially('line one');
      await page.keyboard.press('Shift+Enter');
      await input.pressSequentially('line two');
      expect(await input.inputValue()).toBe('line one\nline two');
      expect(await site.posts()).toHaveLength(0);
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.keyboard.press('Enter')]);
      expect(await site.posts()).toHaveLength(1);
      await context.close();
    });

    it('the placeholder shows the full Markdown hint where there is room', async () => {
      const { page, context } = await open('/chat/channels/ch-1', DESKTOP);
      expect(await page.locator('#message-input').evaluate(el => (el as HTMLTextAreaElement).placeholder)).toBe('Message... (Markdown enabled)');
      await context.close();
    });

    it('modals stay centered cards on desktop', async () => {
      const { page, context } = await open('/chat', DESKTOP);
      await page.getByRole('button', { name: 'Create channel' }).click();
      const card = await box(page, '#create-channel-modal > div');
      expect(card.width).toBeLessThanOrEqual(512 + 1);
      expect(card.y).toBeGreaterThan(40);
      expect(card.y + card.height).toBeLessThan(800 - 40);
      await context.close();
    });
  });

  describe('accessibility and motion', () => {
    it('the conversation list, the message log and one level-1 heading are landmarks a screen reader can find', async () => {
      const list = await open('/chat', phone());
      expect(await list.page.getByRole('navigation', { name: 'Conversations' }).count()).toBe(1);
      await list.context.close();
      const thread = await open('/chat/channels/ch-1', phone());
      expect(await thread.page.getByRole('log', { name: 'Messages' }).count()).toBe(1);
      expect(await thread.page.getByRole('heading', { level: 1 }).count()).toBe(1);
      // the hidden list pane must not be exposed to assistive technology while a thread is open on a phone
      expect(await thread.page.getByRole('navigation', { name: 'Conversations' }).count()).toBe(0);
      await thread.context.close();
    });

    it('with reduced motion requested, nothing in the chat animates', async () => {
      const { page, context } = await open('/chat/channels/ch-1', { ...phone(), reducedMotion: 'reduce' });
      const animating = await page.evaluate(() => [...document.querySelectorAll('.chat-shell *')].filter(el => {
        const s = getComputedStyle(el);
        return parseFloat(s.transitionDuration) > 0 || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0);
      }).length);
      expect(animating).toBe(0);
      await context.close();
    });

    it('a keyboard user can reach every thread control, and the composer controls are in reading order', async () => {
      const { page, context } = await open('/chat/channels/ch-1', DESKTOP);
      const labels = async (key: string, count: number) => {
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          await page.keyboard.press(key);
          out.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a?.getAttribute('aria-label') || a?.id || a?.tagName || ''; }));
        }
        return out;
      };
      // focus starts in the composer (desktop): forward goes attach -> send
      const forward = await labels('Tab', 3);
      expect(forward.slice(0, 2)).toEqual(['Attach file', 'Send message']);
      // backwards from there reaches the conversation controls
      const backward = await labels('Shift+Tab', 60);
      expect(backward).toContain('Create channel');
      expect(backward).toContain('New direct message');
      expect(backward.indexOf('Create channel')).toBeLessThan(backward.indexOf('New direct message')); // reverse of the visual order
      await context.close();
    });
  });
});
