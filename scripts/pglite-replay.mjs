// Replays Prisma migrations on an in-process Postgres (PGlite) to test a migration against existing data.
// Reads JSON on stdin: { target, setup: [{sql, params?}], checks: [{sql, params?}] }.
// Applies every migration older than `target`, runs `setup`, applies `target`, then runs each check in order
// (state carries over between checks; a failing check does not stop the rest) and prints one result per check:
// { ok: true, rows } or { ok: false, error }.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const dir = path.join(process.cwd(), 'prisma', 'migrations');
const names = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isDirectory()).sort();
if (!names.includes(input.target)) throw new Error(`unknown migration ${input.target}`);

const db = await PGlite.create();
for (const name of names.filter(n => n < input.target)) await db.exec(fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'));
for (const step of input.setup || []) await db.query(step.sql, step.params || []);
await db.exec(fs.readFileSync(path.join(dir, input.target, 'migration.sql'), 'utf8'));

const results = [];
for (const check of input.checks) {
  try {
    const res = await db.query(check.sql, check.params || []);
    results.push({ ok: true, rows: res.rows });
  } catch (err) {
    results.push({ ok: false, error: String(err && err.message || err) });
  }
}
await db.close();
process.stdout.write(JSON.stringify({ results, migrations: names.length }));
