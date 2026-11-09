/**
 * WebCrypto implementation of the verifier's crypto primitives: browsers, and Node 20+ through `globalThis.crypto`.
 * Ed25519 needs a reasonably recent browser (Chrome 137, Firefox 129, Safari 17); where it is missing, `ed25519Verify`
 * rejects with UnsupportedEnvironmentError and verifyMatch reports ERROR (never a pass).
 */
import type { CryptoProvider } from './verify';

export class UnsupportedEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEnvironmentError';
  }
}

// Only the WebCrypto calls we use, declared structurally so this file needs neither the DOM typings nor Node's.
interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(format: 'raw', key: Uint8Array, algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  verify(algorithm: { name: string }, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

const subtle = (): SubtleLike => {
  const s = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!s) throw new UnsupportedEnvironmentError('WebCrypto (crypto.subtle) is not available in this environment');
  return s;
};

export const webProvider: CryptoProvider = {
  sha256: async data => new Uint8Array(await subtle().digest('SHA-256', data)),
  ed25519Verify: async (publicKeyRaw, message, signature) => {
    let key: unknown;
    try {
      key = await subtle().importKey('raw', publicKeyRaw, { name: 'Ed25519' }, false, ['verify']);
    } catch (err) {
      throw new UnsupportedEnvironmentError(`Ed25519 is not supported here: ${(err as Error)?.message || err}`);
    }
    return subtle().verify({ name: 'Ed25519' }, key, signature, message);
  }
};
