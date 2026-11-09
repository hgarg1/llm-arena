// Generates a new Ed25519 signing key for match manifests and rotates the published key set.
//
//   node scripts/generate-integrity-key.mjs --secret-out <file> [--keys-file src/integrity/published-keys.json] [--dry-run]
//
// - The private key (a 32-byte seed, base64url) is written ONLY to --secret-out, with mode 0600. It is never printed and
//   never written to the repository. Put its contents in the INTEGRITY_SIGNING_KEY environment variable, then delete the file.
// - The public key is added to the key set as `active`; the key that was active becomes `retired` (its old signatures stay
//   valid). Commit the updated key set and deploy it together with the new INTEGRITY_SIGNING_KEY.
// See docs/INTEGRITY_KEYS.md.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] ?? true); };
const secretOut = flag('--secret-out');
const keysFile = path.resolve(flag('--keys-file') || 'src/integrity/published-keys.json');
const dryRun = args.includes('--dry-run');

if (!secretOut || secretOut === true) {
  console.error('usage: node scripts/generate-integrity-key.mjs --secret-out <file> [--keys-file <file>] [--dry-run]');
  process.exit(2);
}
if (fs.existsSync(secretOut)) {
  console.error(`refusing to overwrite ${secretOut}`);
  process.exit(2);
}

const set = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
if (!Array.isArray(set.keys)) throw new Error('key set must have a "keys" array');

const seed = randomBytes(32);
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
const raw = spki.subarray(spki.length - 32);
const keyId = createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex');

const retired = [];
for (const key of set.keys) if (key.status === 'active') { key.status = 'retired'; retired.push(key.key_id); }
set.keys.push({ key_id: keyId, alg: 'Ed25519', public_key: raw.toString('base64url'), status: 'active' });

if (!dryRun) {
  fs.writeFileSync(secretOut, seed.toString('base64url') + '\n', { mode: 0o600 });
  fs.writeFileSync(keysFile, JSON.stringify(set, null, 2) + '\n');
}
console.log(JSON.stringify({ key_id: keyId, retired, secret_file: dryRun ? null : secretOut, keys_file: dryRun ? null : keysFile, dry_run: dryRun }, null, 2));
