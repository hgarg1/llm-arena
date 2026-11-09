/** Node's implementation of the verifier's crypto primitives (the CLI, the runner, tests). */
import { createHash, createPublicKey, verify } from 'crypto';
import type { CryptoProvider } from './verify';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // wraps a raw 32-byte Ed25519 key for Node's crypto API

export const nodeProvider: CryptoProvider = {
  sha256: data => new Uint8Array(createHash('sha256').update(data).digest()),
  ed25519Verify: (publicKeyRaw, message, signature) => {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyRaw)]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  }
};
