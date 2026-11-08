// Vercel build entry point (`npm run vercel-build`).
//
// OPT-IN: set VERCEL_MIGRATE_ON_BUILD=true on the project to apply pending Prisma migrations during production
// builds. It is off by default because it only works when Vercel's build machines can reach the database
// (they cannot reach an IP-allowlisted database), and a build that cannot migrate must not block every deploy.
// When enabled and a migration fails, the build fails and Vercel keeps serving the previous deployment, so a bad
// migration can never take the live site down. Preview builds never touch a database.
//
// MIGRATE_DATABASE_URL, DIRECT_URL or DATABASE_URL_UNPOOLED (what the Neon integration provides) let migrations use a direct, non-pooled connection when DATABASE_URL
// points at a pooler (migrations take advisory locks, which transaction poolers do not support).
import { spawnSync } from 'node:child_process';

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32', timeout: 10 * 60 * 1000 });
  if (result.error || result.status !== 0) {
    console.error(`\n${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`);
    process.exit(result.status || 1);
  }
};

const migrateOnBuild = ['true', '1'].includes(String(process.env.VERCEL_MIGRATE_ON_BUILD).toLowerCase());

if (process.env.VERCEL_ENV === 'production' && !migrateOnBuild) {
  console.warn('NOT applying migrations (VERCEL_MIGRATE_ON_BUILD is not set). Run `prisma migrate deploy` against the production database before promoting a deployment that adds migrations.');
} else if (process.env.VERCEL_ENV === 'production') {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set for this production build; refusing to deploy without applying migrations.');
    process.exit(1);
  }
  console.log('Applying pending Prisma migrations...');
  run('npx', ['prisma', 'migrate', 'deploy'], { ...process.env, DATABASE_URL: url });
} else {
  console.log(`Skipping migrations (VERCEL_ENV=${process.env.VERCEL_ENV || 'unset'}).`);
}

run('npm', ['run', 'build']);

// One-shot bootstrap, opt-in: VERCEL_SEED_ON_BUILD=true creates roles/permissions, the first admin (from ADMIN_EMAIL and
// ADMIN_PASSWORD) and the built-in mock model, then syncs provider models. Turn it off again after the first successful
// deploy: re-seeding resets the permissions of the built-in roles to their defaults.
const seedOnBuild = ['true', '1'].includes(String(process.env.VERCEL_SEED_ON_BUILD).toLowerCase());
if (process.env.VERCEL_ENV === 'production' && seedOnBuild) {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const env = { ...process.env, DATABASE_URL: url };
  console.log('Seeding roles, admin account and built-in models...');
  run('node', ['prisma/seed.prod.js'], env);
  run('node', ['dist/scripts/sync-models.js'], env);
}
