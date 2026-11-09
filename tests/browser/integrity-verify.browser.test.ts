/// <reference lib="dom" />
/**
 * The verification library in a real browser: the pure modules (canonical, spec, verify, verify-web) are transpiled with
 * TypeScript and loaded into a page that has no Node globals, then run against every published test vector with WebCrypto.
 * Opt in with BROWSER_TESTS=1 (needs `npx playwright-core install chromium`).
 */
import { Browser, chromium } from 'playwright-core';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import ts from 'typescript';

const enabled = process.env.BROWSER_TESTS === '1';
const maybe = enabled ? describe : describe.skip;
const root = path.join(__dirname, '..', '..');

const bundle = (): string => {
  const names = ['spec', 'canonical', 'verify', 'verify-web'];
  const modules = names.map(name => {
    const source = fs.readFileSync(path.join(root, 'src', 'integrity', `${name}.ts`), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    return `define(${JSON.stringify('./' + name)}, function (exports, require) {\n${js}\n});`;
  });
  return `(function () {
  var defs = {}, cache = {};
  function define(name, fn) { defs[name] = fn; }
  function require(name) {
    if (!cache[name]) { var module = { exports: {} }; cache[name] = module.exports; defs[name](module.exports, require); }
    return cache[name];
  }
${modules.join('\n')}
  window.Integrity = { verify: require('./verify'), web: require('./verify-web') };
})();`;
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>verify</title><script src="/bundle.js"></script>`;

maybe('the verification library in a real browser', () => {
  let server: http.Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    const vectors = fs.readFileSync(path.join(root, 'docs', 'integrity', 'test-vectors.json'));
    const js = bundle();
    server = http.createServer((req, res) => {
      const send = (type: string, body: string | Buffer) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
      if (req.url === '/bundle.js') return send('application/javascript', js);
      if (req.url === '/vectors.json') return send('application/json', vectors);
      return send('text/html', PAGE);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); server?.close(); });

  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    return { page, errors };
  };

  it('runs in a page with no Node globals and has Ed25519 available', async () => {
    const { page, errors } = await open();
    const env = await page.evaluate(async () => {
      let ed25519 = true;
      try { await crypto.subtle.generateKey({ name: 'Ed25519' } as any, false, ['sign', 'verify']); } catch { ed25519 = false; }
      return { buffer: typeof (window as any).Buffer, process: typeof (window as any).process, require: typeof (window as any).require, loaded: typeof (window as any).Integrity?.verify?.verifyMatch, ed25519 };
    });
    expect(env).toEqual({ buffer: 'undefined', process: 'undefined', require: 'undefined', loaded: 'function', ed25519: true });
    expect(errors).toEqual([]);
  });

  it('reproduces every published vector with WebCrypto', async () => {
    const { page, errors } = await open();
    const report = await page.evaluate(async () => {
      const { verify, web } = (window as any).Integrity;
      const vectors = await (await fetch('/vectors.json')).json();
      const failures: string[] = [];
      let checked = 0;

      for (const g of vectors.genesis) { checked++; if ((await verify.genesisHash(web.webProvider, g.match_id)) !== g.hash) failures.push('genesis ' + g.match_id); }
      for (const c of vectors.chains) {
        checked++;
        const r = await verify.chainHashes(web.webProvider, c.match_id, c.events);
        if (JSON.stringify(r.hashes) !== JSON.stringify(c.hashes) || r.head !== c.head) failures.push('chain ' + c.name);
      }
      for (const m of vectors.moves_chains) {
        checked++;
        const r = await verify.moveChainHashes(web.webProvider, m.match_id, m.moves);
        if (JSON.stringify(r.hashes) !== JSON.stringify(m.hashes) || r.head !== m.head) failures.push('moves chain ' + m.name);
      }
      for (const v of vectors.verification) {
        checked++;
        const out = await verify.verifyMatch(web.webProvider, v.match_id, v.events, v.envelope, v.keys, { moves: v.moves });
        if (out.result !== v.expect.result || out.code !== v.expect.code) failures.push(`${v.name}: got ${out.result} ${out.code}`);
      }
      return { checked, failures };
    });
    expect(report.failures).toEqual([]);
    expect(report.checked).toBeGreaterThanOrEqual(30);
    expect(errors).toEqual([]);
  });

  it('detects tampering in the page: a changed payload, a removed event, a forged signature', async () => {
    const { page } = await open();
    const outcomes = await page.evaluate(async () => {
      const { verify, web } = (window as any).Integrity;
      const vectors = await (await fetch('/vectors.json')).json();
      const good = vectors.verification[0]; // the untouched match
      const run = (events: any[], envelope = good.envelope) => verify.verifyMatch(web.webProvider, good.match_id, events, envelope, good.keys);
      const edited = JSON.parse(JSON.stringify(good.events)); edited[1].payload.amount = 51;
      const sig = good.envelope.signature.sig;
      const forged = { ...good.envelope, signature: { ...good.envelope.signature, sig: (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1) } };
      return {
        untouched: (await run(good.events)).result,
        edited: (await run(edited)).code,
        removed: (await run(good.events.slice(0, 2))).code,
        forged: (await run(good.events, forged)).code,
        unverified: (await verify.verifyMatch(web.webProvider, good.match_id, good.events, null, good.keys)).result
      };
    });
    expect(outcomes).toEqual({ untouched: 'VERIFIED', edited: 'HEAD_MISMATCH', removed: 'EVENT_COUNT_MISMATCH', forged: 'SIGNATURE_INVALID', unverified: 'UNVERIFIED' });
  });
});
