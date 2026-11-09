import { listGames } from './controllers/admin/games.controller';

async function run() {
  const req = { query: {} } as any;
  const res = { render: () => {} } as any;

  // Warmup
  await listGames(req, res);

  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    await listGames(req, res);
  }
  const end = Date.now();

  console.log(`100 iterations took ${end - start}ms`);
  process.exit(0);
}

run().catch(console.error);
