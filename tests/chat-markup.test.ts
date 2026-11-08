import ejs from 'ejs';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const views = path.join(root, 'views');
const viewSource = fs.readFileSync(path.join(views, 'chat/index.ejs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/chat.css'), 'utf8');

const me = { id: 'u1', email: 'archie@example.com', name: 'Archie Garg', role: 'USER' };
const channels = [
  { id: 'c1', name: 'general', type: 'PUBLIC', is_read_only: false },
  { id: 'c2', name: 'announcements', type: 'SYSTEM', is_read_only: true },
  { id: 'c3', name: 'dm-a-b', type: 'PRIVATE', is_read_only: false }
];
const message = (id: string, userId: string, content: string, extra: any = {}) => ({
  id, user_id: userId, type: 'TEXT', content, created_at: new Date('2026-01-01T10:00:00Z'), deleted_at: null, is_edited: false,
  sender: { name: userId === 'u1' ? 'Archie Garg' : 'Priya', email: 'p@example.com', avatar_url: null }, attachments: [], ...extra
});

const render = (over: Record<string, any> = {}) =>
  ejs.renderFile(path.join(views, 'chat/index.ejs'), {
    title: 'Chat', path: '/chat', user: me, csrfToken: 'tok', settings: {}, unreadChatCount: 0, seo: {}, can: () => false,
    channels, activeChannel: null, messages: [], error: null, success: null, chatMaintenanceMode: false, realtimeEnabled: false, ...over
  }, { views: [views] });

const thread = (over: Record<string, any> = {}) =>
  render({ activeChannel: channels[0], messages: [message('m1', 'u2', 'hello'), message('m2', 'u1', 'mine')], ...over });

describe('chat markup: master/detail', () => {
  it('/chat renders the conversation list as the primary view; a thread renders the thread view', async () => {
    expect(await render()).toContain('data-view="list"');
    expect(await thread()).toContain('data-view="thread"');
  });

  it('the back link to the list exists only in a thread and is labelled', async () => {
    const list = await render();
    expect(list).not.toContain('aria-label="Back to conversations"');
    const html = await thread();
    expect(html).toMatch(/<a href="\/chat" class="chat-back chat-hit[^"]*" aria-label="Back to conversations">/);
  });

  it('conversations are a labelled navigation landmark and only the open one is aria-current', async () => {
    const html = await thread();
    expect(html).toContain('<nav aria-label="Conversations"');
    const list = html.slice(html.indexOf('<nav aria-label="Conversations"'), html.indexOf('</nav>', html.indexOf('<nav aria-label="Conversations"')));
    expect(list.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/chat\/channels\/c1" aria-current="page"/);
  });

  it('an empty account gets guidance instead of a blank list', async () => {
    expect(await render({ channels: [] })).toContain('No conversations yet');
  });

  it('loads its stylesheet', async () => {
    expect(await render()).toContain('href="/css/chat.css"');
  });
});

describe('chat markup: thread', () => {
  it('messages are a live, labelled, keyboard-scrollable log with a jump-to-latest control', async () => {
    const html = await thread();
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/id="messages-container"[^>]*tabindex="0"/);
    expect(html).toContain('id="jump-latest"');
    expect(html).toContain('aria-label="Jump to latest message"');
  });

  it('the composer never autofocuses (that would raise the phone keyboard over the thread) and is fully labelled', async () => {
    const html = await thread();
    expect(html).not.toMatch(/<textarea[^>]*\bautofocus\b/);
    expect(html).toMatch(/<textarea[^>]*aria-label="Message"/);
    expect(html).toContain('enterkeyhint="send"');
    expect(html).toContain('aria-describedby="markdown-hint"');
    expect(html).toContain('id="markdown-hint"');
    expect(html).toContain('aria-label="Send message"');
    expect(html).toContain('aria-label="Attach file"');
  });

  it('keeps the short placeholder for phones in markup and only widens it where there is room', async () => {
    const html = await thread();
    expect(html).toContain('placeholder="Message…"');
    expect(html).toContain("(min-width: 640px)");
  });

  it('only your own messages carry edit/delete, with accessible names and a touch-visible class', async () => {
    const html = await thread();
    const rendered = html.slice(html.indexOf('id="messages-container"'), html.indexOf('id="jump-latest"')); // server-rendered messages only
    expect(rendered.match(/class="chat-actions /g)).toHaveLength(1);
    expect(html).toContain('aria-label="Edit message"');
    expect(html).toContain('aria-label="Delete message"');
    expect(html).toContain("editMessage('m2')");
    expect(html).not.toContain("editMessage('m1')");
  });

  it('message text and attachment names from the server are escaped', async () => {
    const html = await thread({ messages: [message('m9', 'u2', '<script>alert(1)</script>', { attachments: [{ file_type: 'application/pdf', url: 'uploads/x.pdf', file_name: '<img src=x onerror=alert(2)>.pdf', file_size: 2048 }] })] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;.pdf');
  });

  it('shows the right notice, and no composer, in maintenance mode and in read-only channels', async () => {
    const maintenance = await thread({ chatMaintenanceMode: true });
    expect(maintenance).toContain('maintenance mode');
    expect(maintenance).not.toContain('id="chat-form"');
    const readOnly = await thread({ activeChannel: channels[1] });
    expect(readOnly).toContain('This channel is read-only');
    expect(readOnly).not.toContain('id="chat-form"');
    expect(await thread({ chatMaintenanceMode: true, user: { ...me, role: 'ADMIN' } })).toContain('id="chat-form"');
  });

  it('banners are announced to assistive technology', async () => {
    expect(await thread({ error: 'Something failed' })).toMatch(/role="alert"[^>]*>Something failed/);
    expect(await thread({ success: 'Done' })).toMatch(/role="status"[^>]*>Done/);
  });

  it('direct messages show the @ marker and a Block control that is a real, sized button', async () => {
    const html = await thread({ activeChannel: channels[2] });
    expect(html).toMatch(/>\s*@\s*</);
    expect(html).toMatch(/<button onclick="blockCurrentChannelUser\(\)" class="chat-hit /);
  });

  it('empty threads show the quiet state', async () => {
    expect(await thread({ messages: [] })).toContain("It's quiet here");
  });
});

describe('chat markup: modals and shared script', () => {
  it('both modals are labelled dialogs with sized, named close buttons, and become bottom sheets on phones', async () => {
    const html = await render();
    for (const id of ['create-channel', 'create-dm']) {
      expect(html).toMatch(new RegExp(`id="${id}-modal" class="chat-modal [^"]*" role="dialog" aria-modal="true" aria-labelledby="${id}-title"`));
      expect(html).toContain(`id="${id}-title"`);
    }
    expect(html.match(/class="chat-modal-close[^"]*"[^>]*aria-label="Close"/g)).toHaveLength(2);
    expect(html).not.toMatch(/onclick="document\.getElementById\('create-/); // everything goes through the helpers
  });

  it('the modal/search helpers load even with no open thread (the welcome screen uses them)', async () => {
    const html = await render();
    expect(html).toContain('window.openChatModal');
    expect(html).toContain('window.searchUsers');
    expect(html).toContain('window.selectUser');
    expect(html).toContain("openChatModal('create-channel-modal')");
    expect(html).toContain("openChatModal('create-dm-modal')");
  });

  it('user-controlled values are escaped before they reach innerHTML in every client template', () => {
    for (const raw of ['${msg.sender.name}', '${att.file_name}', '${userName}', '${file.name}', '${u.name}', '${u.email}', '${rawContent}', '${att.url}']) {
      expect(viewSource).not.toContain(raw);
    }
    for (const safe of ['esc(msg.sender.name)', 'esc(att.file_name)', 'esc(userName)', 'esc(file.name)', 'esc(rawContent)', 'escape(u.name)', 'escape(u.email)']) {
      expect(viewSource).toContain(safe);
    }
  });

  it('Enter sends only on devices with a precise pointer; the textarea auto-grows; focus is not forced on touch screens', () => {
    expect(viewSource).toContain("e.key === 'Enter' && !e.shiftKey && !coarsePointer");
    expect(viewSource).toContain('function autosizeInput()');
    expect(viewSource).toContain('if (finePointer) input.focus');
  });

  it('follows the visual viewport so the on-screen keyboard never covers the composer', () => {
    expect(viewSource).toContain('window.visualViewport');
    expect(viewSource).toContain("--chat-top");
    expect(viewSource).toContain("--chat-h");
  });
});

describe('chat.css contract', () => {
  it('shows one pane at a time below 1024px, driven by data-view', () => {
    expect(css).toContain('@media (max-width: 1023.98px)');
    expect(css).toMatch(/\.chat-shell\[data-view="list"\] \.chat-thread \{ display: none; \}/);
    expect(css).toMatch(/\.chat-shell\[data-view="thread"\] \.chat-list \{ display: none; \}/);
  });

  it('is an app shell that sizes to the visible viewport and removes the nav tab-bar padding', () => {
    expect(css).toContain('100dvh');
    expect(css).toContain('var(--chat-h');
    expect(css).toMatch(/body:has\(\.chat-shell\) \{ padding-bottom: 0; \}/);
  });

  it('keeps inputs at 16px (no iOS zoom) and respects safe areas', () => {
    expect(css).toMatch(/\.chat-input \{ font-size: 1rem;/);
    expect(css).toContain('env(safe-area-inset-bottom');
  });

  it('shows message actions on touch screens and sizes touch targets to 44px', () => {
    expect(css).toMatch(/@media \(hover: none\), \(any-pointer: coarse\) \{\s*\.chat-actions \{/);
    expect(css).toContain('min-width: 44px; min-height: 44px');
  });

  it('wraps long words and URLs, contains wide content, and respects reduced motion', () => {
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toMatch(/\.markdown-body table \{ display: block; max-width: 100%; overflow-x: auto;/);
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
