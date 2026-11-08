// Realistic load test for the deployed site and match runner. Zero provider cost: matches use mock models.
//
//   LOAD_BASE_URL        site under test (default https://llm-arena.harshit-garg.com)
//   LOAD_EMAIL/PASSWORD  a regular (non-admin) account used to create matches
//   LOAD_DATABASE_URL    direct database URL, used ONLY to observe the system and audit results (read-only queries)
//   LOAD_FAST_MODEL      id of a model with provider "mock"  (answers instantly)
//   LOAD_SLOW_MODEL      id of a mock model with api_model_id "latency-1500" (behaves like a slow provider)
//   LOAD_BROWSERS        concurrent browsing visitors (default 40)
//   LOAD_SESSIONS        logged-in sessions used to create matches (default 5)
//   LOAD_WAVE1 / LOAD_WAVE2   JSON like {"slowChess":20,"poker":20,"blackjack":10,"fastChess":10,"chutes":10}
//   LOAD_WAVE2_DELAY_S   seconds between the waves (default 120)
//   LOAD_BASELINE_S      seconds of browsing-only baseline first (default 30)
//   LOAD_MAX_MINUTES     give up waiting for matches to finish after this long (default 25)
//   LOAD_OUT             where to write the JSON report (default ./load-report.json)
//
// Abort safety: if the match failure rate or the browsing error rate climbs, all test matches are cancelled.

import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const env = (name, fallback) => process.env[name] ?? fallback;
const BASE = env('LOAD_BASE_URL', 'https://llm-arena.harshit-garg.com').replace(/\/$/, '');
const EMAIL = env('LOAD_EMAIL');
const PASSWORD = env('LOAD_PASSWORD');
const FAST = env('LOAD_FAST_MODEL');
const SLOW = env('LOAD_SLOW_MODEL');
const BROWSERS = Number(env('LOAD_BROWSERS', 40));
const SESSIONS = Number(env('LOAD_SESSIONS', 5));
const WAVE1 = JSON.parse(env('LOAD_WAVE1', '{"slowChess":20,"poker":20,"blackjack":10,"fastChess":10,"chutes":10}'));
const WAVE2 = JSON.parse(env('LOAD_WAVE2', '{"slowChess":10,"poker":10,"blackjack":5,"fastChess":5,"chutes":5}'));
const WAVE2_DELAY_S = Number(env('LOAD_WAVE2_DELAY_S', 120));
const BASELINE_S = Number(env('LOAD_BASELINE_S', 30));
const MAX_MINUTES = Number(env('LOAD_MAX_MINUTES', 25));
const OUT = env('LOAD_OUT', './load-report.json');
if (!EMAIL || !PASSWORD || !FAST || !SLOW || !process.env.LOAD_DATABASE_URL) {
  console.error('Missing LOAD_EMAIL, LOAD_PASSWORD, LOAD_FAST_MODEL, LOAD_SLOW_MODEL or LOAD_DATABASE_URL');
  process.exit(2);
}

const db = new PrismaClient({ datasources: { db: { url: process.env.LOAD_DATABASE_URL } } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const round = n => (n === null ? null : Math.round(n));

// ---------- tiny HTTP client with a cookie jar per visitor ----------
class Visitor {
  constructor(label) { this.label = label; this.cookies = new Map(); this.csrf = null; }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async request(path, { method = 'GET', form, timeoutMs = 30_000 } = {}) {
    const headers = { 'user-agent': 'llm-arena-load-test', accept: 'text/html,application/json' };
    if (this.cookies.size) headers.cookie = this.header();
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const started = performance.now();
    let status = 0, text = '', bytes = 0, error = null, location = null;
    try {
      const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      location = res.headers.get('location');
      for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
      text = new TextDecoder().decode(buf);
    } catch (err) { error = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err); }
    return { status, text, bytes, ms: performance.now() - started, error, location };
  }
  async login() {
    const page = await this.request('/auth/login');
    const token = /name="_csrf"\s+value="([^"]+)"/.exec(page.text)?.[1];
    if (!token) throw new Error(`no csrf token on login page (status ${page.status})`);
    const res = await this.request('/auth/login', { method: 'POST', form: { email: EMAIL, password: PASSWORD, _csrf: token } });
    if (res.status !== 302) throw new Error(`login failed with status ${res.status}`);
    const create = await this.request('/matches/create');
    this.csrf = /name="_csrf"\s+value="([^"]+)"/.exec(create.text)?.[1];
    if (!this.csrf) throw new Error('no csrf token on the create-match page');
  }
}

// ---------- measurements ----------
const samples = []; // { phase, route, ms, status, error }
let phase = 'baseline';
const record = (route, r) => samples.push({ phase, route, ms: r.ms, status: r.status, error: r.error, t: Date.now() });

function summarise(filter) {
  const rows = samples.filter(filter);
  const byRoute = {};
  for (const row of rows) (byRoute[row.route] ??= []).push(row);
  const stat = list => {
    const ms = list.map(r => r.ms).sort((a, b) => a - b);
    const bad = list.filter(r => r.error || r.status >= 400 || r.status === 0);
    return { requests: list.length, errors: bad.length, errorRate: list.length ? +(bad.length / list.length).toFixed(4) : 0, p50: round(pct(ms, 50)), p95: round(pct(ms, 95)), p99: round(pct(ms, 99)), max: round(ms[ms.length - 1] ?? null) };
  };
  return { all: stat(rows), routes: Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, stat(v)])) };
}

// ---------- virtual browsing visitors ----------
let stopBrowsing = false;
let replayIds = [];
const ROUTES = [
  ['/', 25], ['/benchmarks', 10], ['/about', 8], ['/how-it-works', 5], ['/methodology', 5], ['/docs', 5], ['/matches', 15],
  ['/auth/login', 4], ['replay', 10], ['events', 8], ['events-after', 5]
];
const pick = () => { let r = Math.random() * ROUTES.reduce((a, [, w]) => a + w, 0); for (const [route, w] of ROUTES) { r -= w; if (r <= 0) return route; } return '/'; };

async function browse(index) {
  const v = new Visitor(`browser-${index}`);
  await sleep(rand(0, 3000)); // stagger the start
  while (!stopBrowsing) {
    const route = pick();
    let path = route, label = route;
    if (route === 'replay') { if (!replayIds.length) continue; path = `/matches/${replayIds[Math.floor(Math.random() * replayIds.length)]}`; label = '/matches/:id'; }
    if (route === 'events') { if (!replayIds.length) continue; path = `/matches/${replayIds[Math.floor(Math.random() * replayIds.length)]}/events`; label = '/matches/:id/events'; }
    if (route === 'events-after') { if (!replayIds.length) continue; path = `/matches/${replayIds[Math.floor(Math.random() * replayIds.length)]}/events?after=${Math.floor(Math.random() * 20)}`; label = '/matches/:id/events?after'; }
    record(label, await v.request(path));
    await sleep(rand(1000, 3000)); // think time
  }
}

// ---------- match creation ----------
const SPEC = {
  slowChess: () => ({ gameType: 'chess', model1Id: SLOW, model2Id: SLOW }),
  fastChess: () => ({ gameType: 'chess', model1Id: FAST, model2Id: FAST }),
  poker: () => ({ gameType: 'texas_holdem', playerCount: '6', dealerSeat: 'random', ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`model${i}Id`, SLOW])) }),
  blackjack: () => ({ gameType: 'blackjack', playerCount: '3', model1Id: SLOW, model2Id: SLOW, model3Id: SLOW, blackjack_starting_stack: '1000', blackjack_fixed_bet: '10', blackjack_allow_double: 'on' }),
  chutes: () => ({ gameType: 'chutes_and_ladders', model1Id: FAST })
};

const created = []; // { kind, at, ok, ms, status }
async function createWave(name, wave, sessions) {
  const jobs = [];
  for (const [kind, count] of Object.entries(wave)) for (let i = 0; i < count; i++) jobs.push(kind);
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  console.log(`[${stamp()}] creating wave "${name}": ${jobs.length} matches`);
  let next = 0;
  const worker = async (session, w) => {
    while (next < jobs.length) {
      const kind = jobs[next++];
      const r = await session.request('/matches', { method: 'POST', form: { ...SPEC[kind](), game_options: '{}', _csrf: session.csrf } });
      record('POST /matches', r);
      created.push({ kind, wave: name, at: Date.now(), ok: r.status === 302 && !(r.location || '').includes('error'), status: r.status, ms: r.ms, location: r.location });
      await sleep(rand(50, 250));
    }
  };
  await Promise.all(sessions.flatMap(s => [worker(s), worker(s)]));
}

// ---------- observation of the system under test ----------
const stamp = () => new Date().toISOString().slice(11, 19);
const series = [];
let loadUserId = null;
async function observe() {
  const [byStatus] = await Promise.all([
    db.$queryRaw`SELECT status::text AS status, COUNT(*)::int AS n FROM "Match" WHERE created_by_id = ${loadUserId} GROUP BY status`
  ]);
  const [{ leased }] = await db.$queryRaw`SELECT COUNT(*)::int AS leased FROM "Match" WHERE status = 'RUNNING' AND lease_expires_at > now()`;
  const [{ orphaned }] = await db.$queryRaw`SELECT COUNT(*)::int AS orphaned FROM "Match" WHERE status = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at < now()) AND created_by_id = ${loadUserId}`;
  const [{ conns }] = await db.$queryRaw`SELECT COUNT(*)::int AS conns FROM pg_stat_activity WHERE datname = current_database()`;
  const counts = Object.fromEntries(byStatus.map(r => [r.status, r.n]));
  const point = { t: Date.now(), counts, leased, orphaned, conns };
  series.push(point);
  return point;
}

async function cancelAll(reason) {
  const r = await db.$executeRaw`UPDATE "Match" SET status = 'CANCELLED', failure_reason = ${reason}, finished_at = now() WHERE created_by_id = ${loadUserId} AND status IN ('PENDING','RUNNING')`;
  console.log(`[${stamp()}] ABORT: cancelled ${r} matches (${reason})`);
}

// ---------- integrity audit ----------
async function audit() {
  const matches = await db.match.findMany({
    where: { created_by_id: loadUserId },
    select: { id: true, game_type: true, status: true, slice_count: true, created_at: true, started_at: true, finished_at: true, lease_owner: true, failure_reason: true, move_failures: true, rate_limit_waits: true, participants: { select: { score: true } }, _count: { select: { moves: true, events: true } } }
  });
  const problems = [];
  for (const m of matches) {
    if (m.status !== 'COMPLETED') { problems.push(`${m.id.slice(0, 8)} ${m.game_type}: status ${m.status} (${m.failure_reason ?? 'no reason'})`); continue; }
    if (m.lease_owner) problems.push(`${m.id.slice(0, 8)}: lease still held`);
    const [{ gaps }] = await db.$queryRaw`SELECT (COUNT(*) - (MAX(seq) + 1))::int AS gaps FROM "MatchEvent" WHERE match_id = ${m.id}`;
    if (gaps !== 0) problems.push(`${m.id.slice(0, 8)} ${m.game_type}: event sequence has ${gaps} gaps/duplicates`);
    const [{ mgaps }] = await db.$queryRaw`SELECT (COUNT(*) - (MAX(move_index) + 1))::int AS mgaps FROM "MatchMove" WHERE match_id = ${m.id}`;
    if (mgaps !== 0) problems.push(`${m.id.slice(0, 8)} ${m.game_type}: move log has ${mgaps} gaps/duplicates`);
    if (m.participants.some(p => p.score === null)) problems.push(`${m.id.slice(0, 8)} ${m.game_type}: a participant has no score`);
  }
  return { matches, problems };
}

// ---------- run ----------
const startedAll = Date.now();
const report = { base: BASE, startedAt: new Date(startedAll).toISOString(), config: { BROWSERS, SESSIONS, WAVE1, WAVE2, WAVE2_DELAY_S, BASELINE_S } };
try {
  const user = await db.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) throw new Error('load-test user not found in the database');
  loadUserId = user.id;
  replayIds = (await db.match.findMany({ where: { status: 'COMPLETED' }, orderBy: { created_at: 'desc' }, take: 20, select: { id: true } })).map(m => m.id);
  if (!replayIds.length) console.log('note: no completed matches yet; replay/event routes are skipped during the baseline');

  console.log(`[${stamp()}] logging in ${SESSIONS} sessions`);
  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) { const s = new Visitor(`creator-${i}`); await s.login(); sessions.push(s); await sleep(500); }

  console.log(`[${stamp()}] phase 1: baseline browsing with ${BROWSERS} visitors for ${BASELINE_S}s`);
  const browsers = Array.from({ length: BROWSERS }, (_, i) => browse(i));
  await sleep(BASELINE_S * 1000);

  phase = 'under-load';
  const loadStart = Date.now();
  console.log(`[${stamp()}] phase 2: matches + browsing`);
  const poll = setInterval(() => observe().then(p => {
    const c = p.counts;
    console.log(`[${stamp()}] pending=${c.PENDING ?? 0} running=${c.RUNNING ?? 0} done=${c.COMPLETED ?? 0} failed=${c.FAILED ?? 0} cancelled=${c.CANCELLED ?? 0} | leased(all)=${p.leased} orphaned=${p.orphaned} pgConns=${p.conns}`);
  }).catch(e => console.log('observe error', e.message)), 5000);

  await createWave('wave1', WAVE1, sessions);
  await sleep(WAVE2_DELAY_S * 1000);
  await createWave('wave2', WAVE2, sessions);

  const totalMatches = created.length;
  let aborted = false;
  const deadline = Date.now() + MAX_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const p = series[series.length - 1];
    if (p) {
      const c = p.counts;
      const terminal = (c.COMPLETED ?? 0) + (c.FAILED ?? 0) + (c.CANCELLED ?? 0);
      if (terminal >= totalMatches) break;
      if ((c.FAILED ?? 0) > Math.max(3, totalMatches * 0.1)) { await cancelAll('load test aborted: too many failed matches'); aborted = true; break; }
    }
    const recent = samples.filter(s => s.t > Date.now() - 30_000 && s.phase === 'under-load');
    if (recent.length > 40 && recent.filter(s => s.error || s.status >= 500 || s.status === 0).length / recent.length > 0.2) { await cancelAll('load test aborted: browsing error rate above 20%'); aborted = true; break; }
    await sleep(2000);
  }
  clearInterval(poll);
  stopBrowsing = true;
  await Promise.allSettled(browsers);
  await observe();

  const end = await audit();
  const finished = end.matches.filter(m => m.finished_at);
  const durations = kind => finished.filter(m => m.game_type === kind).map(m => (m.finished_at - m.created_at) / 1000).sort((a, b) => a - b);
  const waits = finished.filter(m => m.started_at).map(m => (m.started_at - m.created_at) / 1000).sort((a, b) => a - b);
  report.aborted = aborted;
  report.durationSeconds = Math.round((Date.now() - startedAll) / 1000);
  report.loadPhaseSeconds = Math.round((Date.now() - loadStart) / 1000);
  report.creation = { total: created.length, accepted: created.filter(c => c.ok).length, p50ms: round(pct(created.map(c => c.ms).sort((a, b) => a - b), 50)), p95ms: round(pct(created.map(c => c.ms).sort((a, b) => a - b), 95)) };
  report.web = { baseline: summarise(s => s.phase === 'baseline' && s.route !== 'POST /matches'), underLoad: summarise(s => s.phase === 'under-load' && s.route !== 'POST /matches'), creates: summarise(s => s.route === 'POST /matches') };
  report.matches = {
    total: end.matches.length,
    byStatus: end.matches.reduce((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {}),
    sliceCountDistribution: end.matches.reduce((a, m) => ((a[m.slice_count] = (a[m.slice_count] ?? 0) + 1), a), {}),
    secondsToFinish: Object.fromEntries(['chess', 'texas_holdem', 'blackjack', 'chutes_and_ladders'].map(k => [k, { n: durations(k).length, p50: round(pct(durations(k), 50)), p95: round(pct(durations(k), 95)), max: round(durations(k).at(-1) ?? null) }])),
    queueWaitSeconds: { p50: round(pct(waits, 50)), p95: round(pct(waits, 95)), max: round(waits.at(-1) ?? null) },
    rateLimitWaits: end.matches.reduce((a, m) => a + m.rate_limit_waits, 0),
    moveFailures: end.matches.reduce((a, m) => a + m.move_failures, 0)
  };
  report.system = { maxLeasedConcurrently: Math.max(0, ...series.map(s => s.leased)), maxOrphaned: Math.max(0, ...series.map(s => s.orphaned)), maxPgConnections: Math.max(0, ...series.map(s => s.conns)), samples: series.length };
  report.integrityProblems = end.problems;
  report.timeline = series.map(s => ({ s: Math.round((s.t - startedAll) / 1000), ...s.counts, leased: s.leased, conns: s.conns }));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${OUT}`);
} catch (err) {
  console.error('LOAD TEST ERROR:', err);
  stopBrowsing = true;
  if (loadUserId) await cancelAll('load test crashed').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
