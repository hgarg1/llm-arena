// Content hashes of the built-in game engines (docs/INTEGRITY_SPEC.md, manifest member `engine`).
//
//   node scripts/hash-engines.mjs           rewrite src/integrity/engine-hashes.json
//   node scripts/hash-engines.mjs --check   fail (exit 1) if the committed table is out of date
//
// An engine's hash covers its source file(s) and the exact installed version of every library it relies on, so
// upgrading `chess.js` changes the chess engine's identity just as editing chess.ts does. Source is hashed with
// line endings normalised to LF so the hash is the same on Windows and Linux checkouts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[1], '..', '..');
const ENGINES = {
  'iterated-negotiation': { files: ['src/game/negotiation.ts', 'src/game/types.ts'], deps: [] },
  chess: { files: ['src/game/chess.ts', 'src/game/types.ts'], deps: ['chess.js'] },
  chutes_and_ladders: { files: ['src/game/chutes_ladders.ts', 'src/game/types.ts'], deps: [] },
  texas_holdem: { files: ['src/game/poker.ts', 'src/game/types.ts'], deps: ['pokersolver'] },
  blackjack: { files: ['src/game/blackjack.ts', 'src/game/types.ts'], deps: [] }
};
const OUT = path.join(root, 'src', 'integrity', 'engine-hashes.json');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const fileHash = rel => sha256(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'));
const depVersion = name => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// Canonical JSON for the objects used here: keys written in sorted order, no whitespace.
const canon = value => Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`
  : JSON.stringify(value);

const table = {};
for (const [key, { files, deps }] of Object.entries(ENGINES)) {
  const parts = { files: files.map(rel => ({ path: rel, sha256: fileHash(rel) })), deps: Object.fromEntries(deps.map(d => [d, depVersion(d)])) };
  table[key] = { sha256: sha256(canon(parts)), ...parts };
}
const text = JSON.stringify(table, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('src/integrity/engine-hashes.json is out of date. An engine (or a library it uses) changed: run `node scripts/hash-engines.mjs` and commit the result.');
    process.exit(1);
  }
  console.log('engine hashes are up to date');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(root, OUT)}`);
}
