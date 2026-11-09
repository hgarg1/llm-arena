/**
 * Interactive transactions and the hash chain under REAL parallelism: every writer below has its own PrismaClient and so
 * its own database connection, like separate serverless instances. It needs a real Postgres that accepts several
 * connections (the PGlite harness serves one at a time, so `npm run test:db` skips it). Run it against Neon's pooled
 * endpoint, on a throwaway branch, to check the pooler:
 *
 *   VERCEL=1 PARALLEL_CONNECTIONS=1 INTEGRATION_DATABASE_URL=<pooled neon url> npx jest tests/integration/pooler.integration.test.ts
 *
 * VERCEL=1 makes src/config/db.ts add connection_limit=1, exactly as in production.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

import { prisma } from '../../src/config/db';
import * as integrity from '../helpers/integrity-reference';

const maybe = url && process.env.PARALLEL_CONNECTIONS === '1' ? describe : describe.skip;

type Repo = import('../../src/repositories/match.repository').MatchRepository;
const clients: Array<{ $disconnect(): Promise<void> }> = [];

/** A repository on its own PrismaClient (its own connection), the way a separate function instance would have it. */
const freshRepo = (): Repo => {
  let repo!: Repo;
  delete (global as any).prisma; // config/db would otherwise hand every isolate the shared client
  jest.isolateModules(() => {
    const { MatchRepository } = require('../../src/repositories/match.repository');
    clients.push(require('../../src/config/db').prisma);
    repo = new MatchRepository();
  });
  return repo;
};

const newMatch = () => prisma.match.create({ data: { game_type: 'chess', seed: 1, status: 'RUNNING' } });
const stored = (matchId: string) => prisma.matchEvent.findMany({ where: { match_id: matchId }, orderBy: { seq: 'asc' } });
const expectChainIntact = (matchId: string, rows: Awaited<ReturnType<typeof stored>>) => {
  const records = rows.map(e => ({ seq: e.seq, turn_index: e.turn_index, type: e.type, actor_role: e.actor_role, payload: e.payload }));
  expect(rows.map(e => e.seq)).toEqual(rows.map((_, i) => i));
  expect(rows.map(e => e.hash)).toEqual(integrity.chain(matchId, records).hashes);
  expect(rows[0].prev_hash).toBe(integrity.genesisHash(matchId));
  rows.slice(1).forEach((r, i) => expect(r.prev_hash).toBe(rows[i].hash));
};
// Each isolated writer loads its own copy of the modules, so error classes are compared by name, not by instanceof.
const isLoser = (reason: unknown) => ['LeaseLostError', 'IntegrityError'].includes((reason as Error)?.name);

maybe('interactive transactions and the hash chain with parallel connections', () => {
  const WRITERS = 8;
  let repos: Repo[];
  beforeAll(() => { repos = Array.from({ length: WRITERS }, freshRepo); }, 60_000);
  afterAll(async () => { await Promise.all(clients.map(c => c.$disconnect())); });

  it('an interactive transaction commits, and rolls back completely when it throws', async () => {
    const match = await newMatch();
    await expect(prisma.$transaction(async tx => {
      await tx.matchEvent.create({ data: { match_id: match.id, turn_index: 0, seq: 0, type: 'X', actor_role: 'system', payload: {} } });
      expect(await tx.matchEvent.count({ where: { match_id: match.id } })).toBe(1); // visible inside the transaction
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await prisma.matchEvent.count({ where: { match_id: match.id } })).toBe(0);

    await prisma.$transaction(async tx => {
      await tx.matchEvent.create({ data: { match_id: match.id, turn_index: 0, seq: 0, type: 'X', actor_role: 'system', payload: {} } });
    });
    expect(await prisma.matchEvent.count({ where: { match_id: match.id } })).toBe(1);
  });

  it('records a move and its events in one round of interactive transaction with sensible latency', async () => {
    const match = await newMatch();
    const times: number[] = [];
    let seq = 0;
    for (let index = 0; index < 8; index++) {
      const events = [0, 1].map(() => ({ turn_index: seq, seq: seq++, type: 'MOVE', actor_role: 'white', payload: { index } }));
      const started = Date.now();
      await repos[0].recordMove(match.id, { index, actor: 'white', content: `m${index}` }, events);
      times.push(Date.now() - started);
    }
    times.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`recordMove latency over this connection: median ${times[4]} ms, max ${times[7]} ms`);
    expect(times[7]).toBeLessThan(10_000);
    expectChainIntact(match.id, await stored(match.id));
  });

  it(`${WRITERS} runners racing to record the same move: exactly one wins, the rest lose cleanly, the chain is intact`, async () => {
    const match = await newMatch();
    const events = (who: number) => [0, 1].map(seq => ({ turn_index: seq, seq, type: 'MOVE', actor_role: 'white', payload: { who } }));
    const results = await Promise.allSettled(repos.map((repo, who) => repo.recordMove(match.id, { index: 0, actor: 'white', content: `from-${who}` }, events(who))));

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(isLoser(r.reason)).toBe(true);
    const rows = await stored(match.id);
    expect(rows).toHaveLength(2); // only the winner's events; every loser rolled back
    expect(new Set(rows.map(r => (r.payload as any).who)).size).toBe(1);
    expect(await prisma.matchMove.count({ where: { match_id: match.id } })).toBe(1);
    expectChainIntact(match.id, rows);
  });

  it(`${WRITERS} writers appending the same next event: exactly one succeeds, at every position`, async () => {
    const match = await newMatch();
    for (let seq = 0; seq < 5; seq++) {
      const results = await Promise.allSettled(repos.map((repo, who) => repo.addEvents(match.id, [{ turn_index: seq, seq, type: 'STEP', actor_role: 'system', payload: { who } }])));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(isLoser(r.reason)).toBe(true);
    }
    const rows = await stored(match.id);
    expect(rows).toHaveLength(5);
    expectChainIntact(match.id, rows);
  });

  it(`${WRITERS} contending writers extend one chain to 40 events with no gap, repeat or fork`, async () => {
    const match = await newMatch();
    const TARGET = 40;
    let wins = 0;
    let losses = 0;
    await Promise.all(repos.map(async (repo, who) => {
      for (let guard = 0; guard < 400; guard++) {
        const next = await repo.countEvents(match.id);
        if (next >= TARGET) return;
        try {
          await repo.addEvents(match.id, [{ turn_index: next, seq: next, type: 'STEP', actor_role: 'system', payload: { who } }]);
          wins++;
        } catch (err) {
          if (!isLoser(err)) throw err;
          losses++;
        }
      }
    }));
    const rows = await stored(match.id);
    expect(rows).toHaveLength(TARGET);
    expect(wins).toBe(TARGET);
    // eslint-disable-next-line no-console
    console.log(`contention: ${wins} appended, ${losses} attempts lost the race and were rejected`);
    expectChainIntact(match.id, rows);
  }, 120_000);
});
