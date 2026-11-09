/** How a match's verification is shown (story m1-09): the states, the list filter, and the badge and notices on the pages. */
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import { FINAL_MATCH_STATUSES, VERIFICATION_COPY, VerificationState, listVerificationState, parseVerificationFilter, signedMatchWhere, unverifiedMatchWhere, verificationWhere } from '../src/integrity/status';

const root = path.join(__dirname, '..');
const views = path.join(root, 'views');
const render = (file: string, data: Record<string, unknown>) => ejs.renderFile(path.join(views, file), {
  csrfToken: 't', user: null, session: {}, path: '/matches', title: 'T', can: () => false, seo: { title: 'T', description: 'd', canonicalPath: '/x', robots: 'noindex', structuredData: [] }, ...data
}, { views: [views] });

describe('listVerificationState', () => {
  it('a match with a manifest is signed, whatever its status', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) expect(listVerificationState({ status, manifest: { match_id: 'm' } })).toBe('signed');
  });
  it('a finished match without a manifest is unverified', () => {
    for (const status of FINAL_MATCH_STATUSES) for (const manifest of [null, undefined]) expect(listVerificationState({ status, manifest })).toBe('unverified');
  });
  it('a match that has not finished is in progress, never unverified', () => {
    for (const status of ['PENDING', 'RUNNING']) expect(listVerificationState({ status, manifest: null })).toBe('in-progress');
  });
});

describe('the verification filter', () => {
  it('accepts only the two known values; anything else means no filter', () => {
    expect(parseVerificationFilter('signed')).toBe('signed');
    expect(parseVerificationFilter('unverified')).toBe('unverified');
    for (const bad of [undefined, null, '', 'all', 'SIGNED', 'verified', ['signed'], { a: 1 }, 1, "signed' OR 1=1"]) expect(parseVerificationFilter(bad)).toBeUndefined();
  });
  it('signed means "has a manifest"; unverified means "finished and has none"; no filter adds nothing', () => {
    expect(signedMatchWhere).toEqual({ manifest: { isNot: null } });
    expect(unverifiedMatchWhere).toEqual({ manifest: { is: null }, status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } });
    expect(verificationWhere('signed')).toBe(signedMatchWhere);
    expect(verificationWhere('unverified')).toBe(unverifiedMatchWhere);
    expect(verificationWhere(undefined)).toEqual({});
  });
});

describe('the badge', () => {
  const STATES: VerificationState[] = ['in-progress', 'signed', 'verified', 'failed', 'unverified'];
  const badge = async (state: unknown, code?: string) => ejs.renderFile(path.join(views, 'partials/verification_badge.ejs'), { state, code });

  it.each(STATES)('%s shows the label and explanation in the shared copy', async state => {
    const html = await badge(state);
    expect(html).toContain(`data-verification="${state}"`);
    expect(html).toContain(`>${VERIFICATION_COPY[state].label}<`);
    expect(html).toContain(`title="${VERIFICATION_COPY[state].detail.replace(/'/g, '&#39;')}`);
  });

  it('every state differs in its words, its icon shape and its colour, so it is never colour alone', async () => {
    const parts = await Promise.all(STATES.map(async s => { const h = await badge(s); return { label: />([^<]+)<\/span><\/span>$/.exec(h.trim())![1], icon: /<path d="([^"]+)"/.exec(h)![1], cls: /rounded-full border px-2 py-0.5 text-xs font-semibold ([^"]+)"/.exec(h)![1] }; }));
    for (const key of ['label', 'icon', 'cls'] as const) expect(new Set(parts.map(p => p[key])).size).toBe(STATES.length);
  });

  it('an unknown or missing state is shown as unverified, never as signed or verified', async () => {
    for (const bad of [undefined, null, '', 'verified-ish', 42]) expect(await badge(bad)).toContain('data-verification="unverified"');
  });

  it('a failure code is added to the tooltip, and escaped', async () => {
    const html = await badge('failed', 'HEAD_MISMATCH');
    expect(html).toContain('(HEAD_MISMATCH)');
    expect(await badge('failed', '"><script>alert(1)</script>')).not.toContain('<script>');
  });

  it('the icon is hidden from screen readers (the label carries the meaning)', async () => {
    expect(await badge('signed')).toContain('aria-hidden="true"');
  });
});

describe('match history page', () => {
  const match = (id: string, status: string, manifest: unknown) => ({ id, game_type: 'chess', status, created_at: new Date('2026-11-01'), participants: [{ role: 'white', model: { name: 'A' } }, { role: 'black', model: { name: 'B' } }], manifest });
  const page = (over: Record<string, unknown> = {}) => render('matches/list.ejs', {
    matches: [match('signed-0001', 'COMPLETED', { match_id: 'x' }), match('legacy-0002', 'COMPLETED', null), match('live-0003', 'RUNNING', null), match('failed-0004', 'FAILED', null)],
    pagination: { page: 1, totalPages: 1, total: 4 }, query: { search: '', gameType: '', status: '', queue: '', verification: '' },
    games: [], statuses: ['PENDING', 'RUNNING', 'COMPLETED'], queueEnabled: true, ...over
  });

  it('every row shows its own state', async () => {
    const html = await page();
    const states = [...html.matchAll(/data-verification="([a-z-]+)"/g)].map(m => m[1]);
    expect(states).toEqual(['signed', 'unverified', 'in-progress', 'unverified']);
  });

  it('has a Verification column and a labelled filter with the three choices', async () => {
    const html = await page();
    expect(html).toContain('<th class="table-th">Verification</th>');
    expect(html).toContain('data-label="Verification"');
    expect(html).toMatch(/<select name="verification"[^>]*aria-label="Verification"/);
    expect(html).toContain('>All matches<');
    expect(html).toContain('>Signed only<');
    expect(html).toContain('>Unverified only<');
  });

  it('shows the current filter, offers a reset, and keeps the filter when paging', async () => {
    const html = await page({ query: { search: '', gameType: '', status: '', queue: '', verification: 'signed' }, pagination: { page: 2, totalPages: 3, total: 50 } });
    expect(html).toMatch(/<option value="signed" selected>/);
    expect(html).toContain('>Reset<');
    expect(html.match(/verification=signed/g)!.length).toBeGreaterThanOrEqual(2); // Prev and Next both carry it
  });

  it('the filter control submits the form like the others do', () => {
    const source = fs.readFileSync(path.join(views, 'matches/list.ejs'), 'utf8');
    expect(source).toContain("getElementById('matchVerification')");
    expect(source).toMatch(/verification\.addEventListener\('change', submitWithReset\)/);
  });
});

describe('match page', () => {
  const detail = (verification: Record<string, unknown>) => render('matches/detail.ejs', {
    match: { id: 'abc', game_type: 'chess', status: 'COMPLETED', failure_reason: null, participants: [], events: [], created_at: new Date(), finished_at: null, tournament: null },
    renderer: 'chess', boardSize: 100, verification
  });

  it('verified: a badge, and no warning', async () => {
    const html = await detail({ state: 'verified' });
    expect(html).toContain('data-verification="verified"');
    expect(html).not.toContain('data-testid="verification-notice"');
  });

  it('unverified: the badge plus a plain-language notice that says it is not a failure and is never backfilled', async () => {
    const html = await detail({ state: 'unverified' });
    expect(html).toContain('data-verification="unverified"');
    const notice = /data-testid="verification-notice"[\s\S]*?<\/div>/.exec(html)![0];
    expect(notice).toMatch(/Unverified\./);
    expect(notice).toMatch(/not a failure/);
    expect(notice).toMatch(/never add signatures to old matches/);
  });

  it('failed: a red notice with the failure code, telling the reader not to rely on the replay', async () => {
    const html = await detail({ state: 'failed', code: 'HEAD_MISMATCH' });
    const notice = /data-testid="verification-notice"[\s\S]*?<\/div>/.exec(html)![0];
    expect(notice).toContain('failed verification (HEAD_MISMATCH)');
    expect(notice).toMatch(/Do not rely on this replay/);
    expect(notice).toContain('bg-red-50');
  });

  it('in progress: a badge and no notice', async () => {
    const html = await detail({ state: 'in-progress' });
    expect(html).toContain('data-verification="in-progress"');
    expect(html).not.toContain('data-testid="verification-notice"');
  });
});

describe('home and benchmarks', () => {
  it('recent matches on the home page carry their state', async () => {
    const html = await render('public/home.ejs', {
      matches: [{ id: 'abcdef123', game_type: 'chess', status: 'COMPLETED', manifest: { match_id: 'x' }, participants: [] }, { id: 'fedcba321', game_type: 'chess', status: 'COMPLETED', manifest: null, participants: [] }],
      models: [], path: '/'
    });
    expect([...html.matchAll(/data-verification="([a-z-]+)"/g)].map(m => m[1])).toEqual(['signed', 'unverified']);
  });

  it('the leaderboard does not claim its numbers are live or derived from play, and says they are placeholders', async () => {
    const html = await render('public/benchmarks.ejs', { top3: [], models: [], currentPage: 1, totalPages: 0 });
    expect(html).not.toMatch(/Live ELO|derived from competitive play/i);
    expect(html).toContain('data-testid="placeholder-notice"');
    expect(html).toMatch(/Placeholder values/);
    expect(html).toContain('/matches?verification=signed');
  });
});
