/** Raw provider responses: scrubbing credentials, the size limit and truncation marker, the digest, and pricing. */
import { createHash } from 'crypto';
import { MAX_RAW_BYTES, prepareRawResponse, truncateUtf8 } from '../src/integrity/raw-response';
import { REDACTED, scrubSecrets } from '../src/integrity/redact';
import { PriceTable, computeCost, findPrice } from '../src/integrity/pricing';
import { CryptoProvider, verifyRawResponses } from '../src/integrity/verify';
import { nodeProvider } from '../src/integrity/verify-node';
import { webProvider } from '../src/integrity/verify-web';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('scrubSecrets', () => {
  it('replaces credentials under credential-named keys, at any depth and in arrays, whatever the case or separator', () => {
    const body = {
      id: 'resp_1', Authorization: 'Bearer abc', headers: { 'x-api-key': 'k', 'X-Goog-Api-Key': 'g', 'Set-Cookie': 'c=1', nested: [{ api_key: 'k2', ok: 1 }] },
      client_secret: 's', password: 'p', accessToken: 't', refresh_token: 'r', 'proxy-authorization': 'x'
    };
    const out: any = scrubSecrets(body);
    expect(out.id).toBe('resp_1');
    expect(out.Authorization).toBe(REDACTED);
    expect(out.headers['x-api-key']).toBe(REDACTED);
    expect(out.headers['X-Goog-Api-Key']).toBe(REDACTED);
    expect(out.headers['Set-Cookie']).toBe(REDACTED);
    expect(out.headers.nested[0]).toEqual({ api_key: REDACTED, ok: 1 });
    for (const k of ['client_secret', 'password', 'accessToken', 'refresh_token', 'proxy-authorization']) expect(out[k]).toBe(REDACTED);
  });

  it('leaves usage fields alone (a key is matched by name, not by containing the word token)', () => {
    const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, input_tokens: 12, output_tokens: 3, max_tokens: 1024, cache_read_input_tokens: 4 };
    expect(scrubSecrets({ usage })).toEqual({ usage });
  });

  it('masks credential-looking strings anywhere, and any secret the caller names', () => {
    const key = 'my-very-secret-api-key-0123456789';
    const out: any = scrubSecrets({
      text: `Authorization: Bearer abcdefghijklmnop1234 and sk-ant-api03-abcdefghijklmnopqrstu and AIzaSyA1234567890abcdefghijk`,
      echoed: `the key is ${key}, twice: ${key}`, list: [`x ${key}`]
    }, [key]);
    expect(out.text).not.toMatch(/abcdefghijklmnop1234|sk-ant|AIzaSy/);
    expect(out.text).toContain(REDACTED);
    expect(out.echoed).toBe(`the key is ${REDACTED}, twice: ${REDACTED}`);
    expect(out.list[0]).toBe(`x ${REDACTED}`);
    expect(JSON.stringify(out)).not.toContain(key);
  });

  it('ignores very short "secrets" (masking every occurrence of "a" would destroy the response)', () => {
    expect(scrubSecrets({ t: 'banana' }, ['a', ''])).toEqual({ t: 'banana' });
  });

  it('never modifies its input, copes with cycles, and drops what JSON would drop', () => {
    const input: any = { a: { Authorization: 'x' }, fn: () => 1, u: undefined };
    input.self = input;
    const snapshot = JSON.stringify({ a: input.a });
    const out: any = scrubSecrets(input);
    expect(JSON.stringify({ a: input.a })).toBe(snapshot);
    expect(input.a.Authorization).toBe('x');
    expect(out.self).toBe('[circular]');
    expect(out).not.toHaveProperty('fn');
    expect(out).not.toHaveProperty('u');
  });

  it('passes numbers, booleans and null through', () => {
    expect(scrubSecrets({ n: 1.5, b: false, z: null, arr: [1, null, 'x'] })).toEqual({ n: 1.5, b: false, z: null, arr: [1, null, 'x'] });
  });
});

describe('prepareRawResponse', () => {
  it('stores the scrubbed response as JSON with its byte length and a digest of the whole text', () => {
    const raw = prepareRawResponse({ id: 'r1', choices: [{ text: 'e2e4' }], Authorization: 'Bearer zzzzzzzzzzzzzzzz' })!;
    expect(JSON.parse(raw.text)).toEqual({ id: 'r1', choices: [{ text: 'e2e4' }], Authorization: REDACTED });
    expect(raw.truncated).toBe(false);
    expect(raw.bytes).toBe(Buffer.byteLength(raw.text, 'utf8'));
    expect(raw.sha256).toBe(sha256(raw.text));
    expect(raw.text).not.toContain('zzzzzzzz');
  });

  it('there is no response to keep when the adapter gave none', () => {
    expect(prepareRawResponse(undefined)).toBeNull();
    expect(prepareRawResponse(null)!.text).toBe('null');
  });

  describe('the size limit and the truncation marker', () => {
    const big = { text: 'x'.repeat(MAX_RAW_BYTES * 2) };
    const full = JSON.stringify(big);

    it('a response over the limit is stored cut off, marked truncated, and its digest and size describe the whole', () => {
      const raw = prepareRawResponse(big)!;
      expect(raw.truncated).toBe(true);
      expect(Buffer.byteLength(raw.text, 'utf8')).toBeLessThanOrEqual(MAX_RAW_BYTES);
      expect(raw.bytes).toBe(Buffer.byteLength(full, 'utf8'));
      expect(raw.sha256).toBe(sha256(full));
      expect(full.startsWith(raw.text)).toBe(true);
    });

    it('exactly at the limit is not truncated; one byte over is', () => {
      const exact = { t: 'x'.repeat(MAX_RAW_BYTES - JSON.stringify({ t: '' }).length) };
      expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_RAW_BYTES);
      expect(prepareRawResponse(exact)!.truncated).toBe(false);
      expect(prepareRawResponse({ t: exact.t + 'x' })!.truncated).toBe(true);
    });

    it('never splits a multi-byte character when cutting', () => {
      const emoji = { t: '\u{1F600}'.repeat(MAX_RAW_BYTES) }; // 4 bytes each
      const raw = prepareRawResponse(emoji)!;
      expect(raw.truncated).toBe(true);
      expect(raw.text).not.toContain('�');
      expect(Buffer.byteLength(raw.text, 'utf8')).toBeLessThanOrEqual(MAX_RAW_BYTES);
      expect(truncateUtf8('a€b', 2)).toBe('a'); // the euro sign needs 3 bytes
    });

    it('a smaller limit can be passed (and the digest is still over the whole)', () => {
      const raw = prepareRawResponse({ t: 'y'.repeat(100) }, [], 40)!;
      expect(raw.truncated).toBe(true);
      expect(raw.text.length).toBeLessThanOrEqual(40);
      expect(raw.sha256).toBe(sha256(JSON.stringify({ t: 'y'.repeat(100) })));
    });
  });

  it('credentials are scrubbed before the digest is taken, so the digest never depends on a secret', () => {
    const a = prepareRawResponse({ echoed: 'key sk-abcdefghijklmnopqrstuvwxyz' })!;
    const b = prepareRawResponse({ echoed: 'key sk-zyxwvutsrqponmlkjihgfedcba' })!;
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('pricing', () => {
  const prices: PriceTable = { version: '2026-11-01', models: [
    { provider: 'anthropic', model_prefix: 'claude', input_per_mtok: 1, output_per_mtok: 5 },
    { provider: 'anthropic', model_prefix: 'claude-big', input_per_mtok: 10, output_per_mtok: 50 },
    { provider: 'openai', model_prefix: 'gpt-x', input_per_mtok: 2, output_per_mtok: 8 }
  ] };
  const usage = { input_tokens: 2_000_000, output_tokens: 500_000, source: 'provider' as const };

  it('computes from the rates and records which rates and which table version it used', () => {
    expect(computeCost(prices, 'openai', 'gpt-x-mini', 'unknown', usage)).toEqual({ usd: 8, basis: 'provider-usage', pricing: { input_per_mtok: 2, output_per_mtok: 8, table_version: '2026-11-01' } });
  });
  it('the longest matching prefix wins, and the reported model is tried as well as the requested one', () => {
    expect(findPrice(prices, 'anthropic', 'claude-big-2')!.input_per_mtok).toBe(10);
    expect(findPrice(prices, 'anthropic', 'claude-small')!.input_per_mtok).toBe(1);
    expect(findPrice(prices, 'anthropic', 'alias', 'claude-big-20260101')!.input_per_mtok).toBe(10);
  });
  it('is unknown, never zero, without a matching price, without a table version, or without real token counts', () => {
    const unknown = { usd: 'unknown', basis: 'unknown', pricing: 'unknown' };
    expect(computeCost(prices, 'openai', 'other', 'unknown', usage)).toEqual(unknown);
    expect(computeCost(prices, 'google', 'gpt-x', 'unknown', usage)).toEqual(unknown);
    expect(computeCost({ ...prices, version: null }, 'openai', 'gpt-x', 'unknown', usage)).toEqual(unknown);
    expect(computeCost(prices, 'openai', 'gpt-x', 'unknown', { ...usage, input_tokens: 'unknown' })).toEqual(unknown);
  });
  it('cost from estimated tokens says so', () => {
    expect(computeCost(prices, 'openai', 'gpt-x', 'unknown', { ...usage, source: 'estimated' }).basis).toBe('estimated-usage');
  });
  it('rounds to a stable number of decimals', () => {
    expect(computeCost(prices, 'openai', 'gpt-x', 'unknown', { input_tokens: 1, output_tokens: 1, source: 'provider' }).usd).toBe(0.00001);
  });
  it('the shipped price list is empty on purpose (prices must come from a provider price list, never from code)', () => {
    const shipped = require('../src/config/model-pricing.json');
    expect(shipped.models).toEqual([]);
    expect(shipped.version).toBeNull();
  });
});

describe.each<[string, CryptoProvider]>([['node crypto', nodeProvider], ['WebCrypto', webProvider]])('verifyRawResponses with %s', (_n, provider) => {
  const make = (obj: unknown, maxBytes?: number) => prepareRawResponse(obj, [], maxBytes)!;
  const moveFor = (index: number, raw: ReturnType<typeof make> | 'unknown' | null) => ({
    move_index: index, provenance: { response: raw && raw !== 'unknown' ? { sha256: raw.sha256, bytes: raw.bytes, truncated: raw.truncated } : raw }
  });
  const record = (index: number, raw: ReturnType<typeof make>) => ({ move_index: index, ...raw });

  it('classifies each move: verified, truncated, missing, mismatch', async () => {
    const ok = make({ a: 1 });
    const cut = make({ t: 'z'.repeat(200) }, 50);
    const gone = make({ b: 2 });
    const changed = make({ c: 3 });
    const moves = [moveFor(0, ok), moveFor(1, cut), moveFor(2, gone), moveFor(3, changed)];
    const raws = [record(0, ok), record(1, cut), record(3, { ...changed, text: '{"c":4}', bytes: changed.bytes })];
    expect(await verifyRawResponses(provider, moves, raws)).toEqual([
      { move_index: 0, status: 'verified' }, { move_index: 1, status: 'truncated' }, { move_index: 2, status: 'missing' }, { move_index: 3, status: 'mismatch' }
    ]);
  });

  it('moves with no raw response kept (engine moves, adapters that keep none) are not reported at all', async () => {
    expect(await verifyRawResponses(provider, [moveFor(0, null), moveFor(1, 'unknown'), { move_index: 2, provenance: null }], [])).toEqual([]);
  });

  it('a response whose digest fields disagree with the signed provenance is a mismatch, even if its text hashes correctly', async () => {
    const real = make({ a: 1 });
    const other = make({ a: 2 });
    expect(await verifyRawResponses(provider, [moveFor(0, real)], [record(0, other)])).toEqual([{ move_index: 0, status: 'mismatch' }]);
    expect(await verifyRawResponses(provider, [moveFor(0, real)], [{ ...record(0, real), truncated: true }])).toEqual([{ move_index: 0, status: 'mismatch' }]);
  });

  it('a truncated copy longer than the whole it claims to be a prefix of is a mismatch', async () => {
    const cut = make({ t: 'z'.repeat(200) }, 50);
    expect(await verifyRawResponses(provider, [moveFor(0, cut)], [{ ...record(0, cut), text: cut.text + 'x'.repeat(500) }])).toEqual([{ move_index: 0, status: 'mismatch' }]);
  });
});
