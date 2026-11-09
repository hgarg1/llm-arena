// Starts an in-process Postgres (PGlite) with every Prisma migration applied, exposes it on a local port,
// and runs the database integration tests against it. No Docker or external database required.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
const port = Number(process.env.PGLITE_PORT || 54329);

const db = await PGlite.create();
const names = fs.readdirSync(migrationsDir).filter(n => fs.statSync(path.join(migrationsDir, n)).isDirectory()).sort();
for (const name of names) {
  await db.exec(fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8'));
}
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`PGlite ready on :${port} with ${names.length} migrations applied`);

const child = spawn('npx', ['jest', 'tests/integration', '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    INTEGRATION_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?connection_limit=1&sslmode=disable&pgbouncer=true`
  }
});
child.on('exit', async code => {
  await server.stop();
  await db.close();
  process.exit(code ?? 1);
});
