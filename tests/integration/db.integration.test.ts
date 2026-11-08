/**
 * Runs the real repository / service / controller code against a real Postgres.
 * Enabled with INTEGRATION_DATABASE_URL (e.g. a throwaway database with all migrations applied);
 * skipped otherwise so the default `npm test` needs no database.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
if (url) {
  process.env.DATABASE_URL = url;
  delete process.env.MATCH_QUEUE_ENABLED;
}

jest.mock('bcrypt', () => ({}));
jest.mock('../../src/services/audit.service', () => ({ logAdminAction: jest.fn() }));

import { prisma } from '../../src/config/db';
import { MatchRepository, LeaseLostError } from '../../src/repositories/match.repository';
import { MatchStatus } from '@prisma/client';
import { ensureDefaultGames, ensureNativeArtifacts } from '../../src/services/default-games.service';
import { reserveUsage, releaseUsage } from '../../src/services/usage-counter.service';
import { runMatch, runMatchSlice, RunnerRepo, SliceResult } from '../../src/services/match-runner.service';
import { sweepMatches } from '../../src/services/runner/sweeper';
import { getRunnerStats } from '../../src/services/runner/stats';
import { PrismaSessionStore } from '../../src/config/session-store';
import express from 'express';
import session from 'express-session';
import http from 'http';
import { AddressInfo } from 'net';
import { RBAC_PERMISSIONS } from '../../src/constants/rbac-permissions';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { takeFromBucket, createDbRateLimiter } from '../../src/services/rate-limit.service';
import { acceptSlice } from '../../src/services/runner/slice-handler';
import { scriptedAdapter } from '../helpers/scripted-adapter';
import { resolveGameEngine, getGameEngine } from '../../src/game/registry';
import { getModelAdapter } from '../../src/game/adapters';
import { activateDueScheduledGames } from '../../src/services/game-release.service';
import { MatchService } from '../../src/services/match.service';
import { cancelMatch, retryMatch } from '../../src/controllers/admin.controller';

const maybe = url ? describe : describe.skip;
const uid = () => Math.random().toString(36).slice(2, 10);
const repo = new MatchRepository();

const GENERATED = `export default class Race {
  n = 0;
  initialize() { this.n = 0; return [{ turn: 0, actor: 'system', type: 'START', payload: {} }]; }
  processMove(h: any, m: any) {
    this.n++;
    const events = [{ turn: h[h.length - 1].turn + 1, actor: m.actor, type: 'STEP', payload: { content: m.content } }];
    return { events, result: this.n >= 3 ? { isFinished: true, scores: { player1: 1, player2: 0 } } : null };
  }
  getSystemPrompt(r: string) { return 'run ' + r; }
  getRandomMove(h: any, r: string) { return { actor: r, content: 'go' }; }
}`;

const mockModel = (provider = 'mock') => prisma.model.create({ data: { name: `${provider}-${uid()}`, api_provider: provider, api_model_id: `${provider}-v1` } });

const createMatch = async (gameType: string, roles: string[], extra: any = {}, provider = 'mock') => {
  const models = await Promise.all(roles.map(() => mockModel(provider)));
  return prisma.match.create({
    data: {
      game_type: gameType,
      seed: 7,
      participants: { create: models.map((m, i) => ({ model_id: m.id, role: roles[i] })) },
      ...extra
    },
    include: { participants: true }
  });
};

const res = () => {
  const r: any = { redirected: '' };
  r.redirect = (u: string) => { r.redirected = decodeURIComponent(u); };
  return r;
};

maybe('database integration', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  describe('default games', () => {
    it('seeds built-ins with a NATIVE artifact each, idempotently', async () => {
      await ensureDefaultGames();
      await ensureDefaultGames();
      for (const key of ['chess', 'chutes_and_ladders', 'texas_holdem', 'blackjack']) {
        const game = await prisma.gameDefinition.findUnique({ where: { key }, include: { engine_artifacts: true, settings: true } });
        expect(game?.status).toBe('LIVE');
        expect(game!.settings.length).toBeGreaterThan(0);
        const native = game!.engine_artifacts.filter(a => a.kind === 'NATIVE');
        expect(native).toHaveLength(1);
        expect(native[0]).toMatchObject({ status: 'PUBLISHED', native_key: key });
      }
      await ensureNativeArtifacts();
      expect(await prisma.gameEngineArtifact.count({ where: { kind: 'NATIVE', native_key: 'chess' } })).toBe(1);
    });

    it('resolves a pinned native artifact and a generated artifact from the database', async () => {
      const native = await prisma.gameEngineArtifact.findFirst({ where: { kind: 'NATIVE', native_key: 'chess' } });
      const resolved = await resolveGameEngine('chess', native!.id);
      expect(resolved.artifactId).toBe(native!.id);
      expect(resolved.engine.gameType).toBe('chess');

      const key = `gen-${uid()}`;
      const game = await prisma.gameDefinition.create({ data: { key, name: key, roles: ['player1', 'player2'], capabilities: [], status: 'LIVE' } });
      await prisma.gameEngineArtifact.create({ data: { game_id: game.id, status: 'PUBLISHED', spec: {}, code_ts: GENERATED } });
      const engine = await getGameEngine(key);
      expect(engine.initialize(1)).toHaveLength(1);
      engine.dispose?.();
    });
  });

  describe('match persistence', () => {
    it('stores ordered events with seq, scores as floats, and orders replay by seq', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      await repo.addEvents(match.id, [
        { turn_index: 1, seq: 2, type: 'C', actor_role: 'white', payload: {} },
        { turn_index: 0, seq: 0, type: 'A', actor_role: 'system', payload: {} },
        { turn_index: 0, seq: 1, type: 'B', actor_role: 'system', payload: { n: 1 } }
      ]);
      await repo.setParticipantScore(match.participants[0].id, 0.5);
      const loaded = await repo.findById(match.id);
      expect(loaded!.events.map(e => e.type)).toEqual(['A', 'B', 'C']);
      expect(loaded!.participants.find(p => p.id === match.participants[0].id)!.score).toBe(0.5);
      await repo.clearEvents(match.id);
      expect((await repo.findById(match.id))!.events).toHaveLength(0);
    });

    it('transitionStatus only moves a match out of the expected states', async () => {
      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' });
      expect(await repo.transitionStatus(match.id, [MatchStatus.PENDING], MatchStatus.COMPLETED)).toBe(false);
      expect(await repo.transitionStatus(match.id, [MatchStatus.RUNNING], MatchStatus.COMPLETED, new Date(), 'note')).toBe(true);
      const row = await prisma.match.findUnique({ where: { id: match.id } });
      expect(row).toMatchObject({ status: 'COMPLETED', failure_reason: 'note' });
      expect(row!.finished_at).not.toBeNull();
      expect(await repo.getStatus(match.id)).toBe('COMPLETED');
    });

    it('stores options and pins the native artifact when a match is created', async () => {
      const model = await mockModel();
      const match = await new MatchService().createMatch([{ modelId: model.id, role: 'player1' }], 'chutes_and_ladders', { boardSize: 50 }, undefined);
      const row = await prisma.match.findUnique({ where: { id: match.id } });
      expect(row!.options).toEqual({ boardSize: 50 });
      const native = await prisma.gameEngineArtifact.findFirst({ where: { kind: 'NATIVE', native_key: 'chutes_and_ladders' } });
      expect(row!.engine_artifact_id).toBe(native!.id);
    });

    it('pins a generated game to the artifact that was published at creation time', async () => {
      const key = `pin-${uid()}`;
      const game = await prisma.gameDefinition.create({ data: { key, name: key, roles: ['player1', 'player2'], capabilities: [], status: 'LIVE' } });
      const artifact = await prisma.gameEngineArtifact.create({ data: { game_id: game.id, status: 'PUBLISHED', spec: {}, code_ts: GENERATED } });
      const model = await mockModel();
      const match = await new MatchService().createMatch([{ modelId: model.id, role: 'player1' }], key, {}, undefined);
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.engine_artifact_id).toBe(artifact.id);
    });
  });

  describe('running matches end to end (real repository)', () => {
    const asRunnerRepo = repo as unknown as RunnerRepo;
    const deps = (extra: any = {}) => ({ repo: asRunnerRepo, getEngine: getGameEngine, getAdapter: getModelAdapter, maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra });

    it('plays poker with mock models, persists everything, and scores participants', async () => {
      const match = await createMatch('texas_holdem', ['seat1', 'seat2', 'seat3']);
      await runMatch(match.id, { playerCount: 3, startingStack: 300 }, deps());
      const row = await repo.findById(match.id);
      expect(row!.status).toBe('COMPLETED');
      expect(row!.events[0].type).toBe('MATCH_START');
      expect(row!.events[row!.events.length - 1].type).toBe('RESULT');
      expect(row!.events.map(e => e.seq)).toEqual(row!.events.map((_, i) => i));
      expect(row!.participants.every(p => p.score !== null)).toBe(true);
      const stacks = (row!.events[row!.events.length - 1].payload as any).final_stacks as number[];
      expect(stacks.reduce((a, b) => a + b, 0)).toBe(900);
    });

    it('running an already finished match again is a no-op (nothing is replayed or duplicated)', async () => {
      const match = await createMatch('chutes_and_ladders', ['player1']);
      await runMatch(match.id, {}, deps());
      const before = await repo.findById(match.id);
      const result = await runMatch(match.id, {}, deps());
      const after = await repo.findById(match.id);
      expect(result).toEqual({ done: true, status: 'finished' });
      expect(after!.events).toHaveLength(before!.events.length);
      expect(after!.events.filter(e => e.type === 'MATCH_START')).toHaveLength(1);
    });

    it('runs a generated engine through the registry, pinned by artifact id', async () => {
      const key = `run-${uid()}`;
      const game = await prisma.gameDefinition.create({ data: { key, name: key, roles: ['player1', 'player2'], capabilities: [], status: 'LIVE' } });
      const artifact = await prisma.gameEngineArtifact.create({ data: { game_id: game.id, status: 'PUBLISHED', spec: {}, code_ts: GENERATED } });
      const match = await createMatch(key, ['player1', 'player2'], { engine_artifact_id: artifact.id });
      await runMatch(match.id, {}, deps());
      const row = await repo.findById(match.id);
      expect(row!.status).toBe('COMPLETED');
      expect(row!.events.filter(e => e.type === 'STEP')).toHaveLength(3);
      expect(row!.participants.map(p => p.score).sort()).toEqual([0, 1]);
    });

    it('a failure leaves the match FAILED with the reason stored', async () => {
      const match = await createMatch('chess', ['white', 'observer']); // no participant for black
      await expect(runMatch(match.id, {}, deps())).rejects.toThrow(/role "black"/);
      const row = await prisma.match.findUnique({ where: { id: match.id } });
      expect(row!.status).toBe('FAILED');
      expect(row!.failure_reason).toMatch(/black/);
    });

    it('stops at the next move when the match is cancelled mid-run, and stays CANCELLED', async () => {
      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' }, 'openai');
      let moves = 0;
      const adapter = { generateMove: async () => { moves++; if (moves === 2) await prisma.match.update({ where: { id: match.id }, data: { status: 'CANCELLED' } }); return moves % 2 ? 'e2e4' : 'e7e5'; } };
      await runMatch(match.id, { maxPlies: 1000 }, deps({ getAdapter: () => adapter }));
      const row = await repo.findById(match.id);
      expect(row!.status).toBe('CANCELLED');
      expect(row!.events[row!.events.length - 1].type).toBe('MATCH_CANCELLED');
    });
  });

  describe('admin cancel / retry (real SQL)', () => {
    const call = async (fn: any, id: string) => { const r = res(); await fn({ params: { id }, session: { userId: 'a' } }, r); return r; };

    it('cancels pending and running matches but not finished ones', async () => {
      const pending = await createMatch('chess', ['white', 'black']);
      const done = await createMatch('chess', ['white', 'black'], { status: 'COMPLETED' });
      expect((await call(cancelMatch, pending.id)).redirected).toContain('success=Match cancelled');
      expect((await prisma.match.findUnique({ where: { id: pending.id } }))!.status).toBe('CANCELLED');
      expect((await call(cancelMatch, done.id)).redirected).toMatch(/Only pending or running/);
      expect((await prisma.match.findUnique({ where: { id: done.id } }))!.status).toBe('COMPLETED');
    });

    it('refuses retry without a runner, and never retries a running match', async () => {
      const running = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' });
      expect((await call(retryMatch, running.id)).redirected).toMatch(/No match runner is configured/);
      expect((await prisma.match.findUnique({ where: { id: running.id } }))!.status).toBe('RUNNING');
    });
  });

  describe('quota (atomic upsert SQL)', () => {
    const key = `quota.test.${uid()}`;
    beforeAll(async () => { await prisma.subscriptionEntitlement.create({ data: { key } }); });
    const target = (scopeId: string) => ({ entitlementKey: key, scopeType: 'USER' as const, scopeId, window: 'day' as const });

    it('allows exactly `limit` reservations under concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => reserveUsage({ ...target('u-concurrent'), limit: 5 })));
      expect(results.filter(Boolean)).toHaveLength(5);
      const row = await prisma.usageCounter.findFirst({ where: { entitlement_key: key, scope_id: 'u-concurrent' } });
      expect(row!.count).toBe(5);
    });

    it('release frees a unit, never goes below zero, and scopes are independent', async () => {
      expect(await reserveUsage({ ...target('u-release'), limit: 1 })).toBe(true);
      expect(await reserveUsage({ ...target('u-release'), limit: 1 })).toBe(false);
      await releaseUsage(target('u-release'));
      expect(await reserveUsage({ ...target('u-release'), limit: 1 })).toBe(true);
      await releaseUsage(target('u-release'));
      await releaseUsage(target('u-release'));
      await releaseUsage(target('u-release'));
      const row = await prisma.usageCounter.findFirst({ where: { entitlement_key: key, scope_id: 'u-release' } });
      expect(row!.count).toBe(0);
      expect(await reserveUsage({ ...target('u-other'), limit: 1 })).toBe(true);
    });
  });

  describe('scheduled releases and revisions', () => {
    it('activates a due release only when the game still has a published runtime', async () => {
      const mk = async (published: boolean) => {
        const key = `sched-${uid()}`;
        const game = await prisma.gameDefinition.create({ data: { key, name: key, status: 'SCHEDULED', roles: [], capabilities: [] } });
        if (published) await prisma.gameEngineArtifact.create({ data: { game_id: game.id, status: 'PUBLISHED', spec: {}, code_ts: GENERATED } });
        const release = await prisma.gameRelease.create({ data: { game_id: game.id, status: 'SCHEDULED', publish_at: new Date(Date.now() - 1000) } });
        return { game, release };
      };
      const ok = await mk(true);
      const blocked = await mk(false);
      await activateDueScheduledGames();
      expect((await prisma.gameDefinition.findUnique({ where: { id: ok.game.id } }))!.status).toBe('LIVE');
      expect((await prisma.gameRelease.findUnique({ where: { id: ok.release.id } }))!.status).toBe('LIVE');
      expect((await prisma.gameRelease.findUnique({ where: { id: blocked.release.id } }))!.status).toBe('DRAFT');
      expect((await prisma.gameDefinition.findUnique({ where: { id: blocked.game.id } }))!.status).toBe('SCHEDULED');
    });

    it('duplicate revision numbers are rejected with the error code the controller retries on', async () => {
      const key = `rev-${uid()}`;
      const game = await prisma.gameDefinition.create({ data: { key, name: key, roles: [], capabilities: [] } });
      await prisma.gameRevision.create({ data: { game_id: game.id, revision: 1, snapshot: { _affects_engine: false } } });
      await expect(prisma.gameRevision.create({ data: { game_id: game.id, revision: 1, snapshot: {} } })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('resumable execution (real SQL)', () => {
    const asRunnerRepo = repo as unknown as RunnerRepo;
    const mk = (extra: any = {}) => ({ repo: asRunnerRepo, getEngine: getGameEngine, getAdapter: () => scriptedAdapter(), maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra });

    it('only one of many concurrent runners can take the lease', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        repo.acquireLease(match.id, `runner-${i}`, 60_000, [MatchStatus.PENDING, MatchStatus.RUNNING])));
      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await prisma.match.findUnique({ where: { id: match.id } });
      expect(row!.lease_owner).toMatch(/^runner-/);
      expect(row!.slice_count).toBe(1);
    });

    it('an expired lease can be taken over, a live one cannot, and only the owner can renew or release it', async () => {
      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' });
      const states = [MatchStatus.PENDING, MatchStatus.RUNNING];
      expect(await repo.acquireLease(match.id, 'A', 60_000, states)).toBe(true);
      expect(await repo.acquireLease(match.id, 'B', 60_000, states)).toBe(false);
      expect(await repo.renewLease(match.id, 'B', 60_000)).toBe(false);
      expect(await repo.renewLease(match.id, 'A', 60_000)).toBe(true);
      await prisma.match.update({ where: { id: match.id }, data: { lease_expires_at: new Date(Date.now() - 1000) } });
      expect(await repo.acquireLease(match.id, 'B', 60_000, states)).toBe(true);
      expect(await repo.renewLease(match.id, 'A', 60_000)).toBe(false);
      await repo.releaseLease(match.id, 'A'); // not the owner: ignored
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.lease_owner).toBe('B');
      await repo.releaseLease(match.id, 'B');
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.lease_owner).toBeNull();
    });

    it('will not lease a finished or cancelled match, and renew fails once it is cancelled', async () => {
      const done = await createMatch('chess', ['white', 'black'], { status: 'COMPLETED' });
      expect(await repo.acquireLease(done.id, 'A', 60_000, [MatchStatus.PENDING, MatchStatus.RUNNING])).toBe(false);
      const running = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' });
      await repo.acquireLease(running.id, 'A', 60_000, [MatchStatus.RUNNING]);
      await prisma.match.update({ where: { id: running.id }, data: { status: 'CANCELLED' } });
      expect(await repo.renewLease(running.id, 'A', 60_000)).toBe(false);
    });

    it('records a move and its events atomically, exactly once, and resets the failure counter', async () => {
      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING', move_failures: 2 });
      const event = (seq: number) => ({ turn_index: 1, seq, type: 'MOVE', actor_role: 'white', payload: { n: seq } });
      await repo.recordMove(match.id, { index: 0, actor: 'white', content: 'e2e4' }, [event(0), event(1)]);
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.move_failures).toBe(0);
      await expect(repo.recordMove(match.id, { index: 0, actor: 'white', content: 'd2d4' }, [event(2)])).rejects.toBeInstanceOf(LeaseLostError);
      expect(await repo.countEvents(match.id)).toBe(2); // the losing writer's events were rolled back
      expect(await repo.getMoves(match.id)).toEqual([{ move_index: 0, actor_role: 'white', content: 'e2e4' }]);
    });

    it('counts consecutive move failures and findEventsAfter returns only newer events', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      expect(await repo.recordMoveFailure(match.id)).toBe(1);
      expect(await repo.recordMoveFailure(match.id)).toBe(2);
      await repo.resetMoveFailures(match.id);
      expect(await repo.recordMoveFailure(match.id)).toBe(1);
      await repo.addEvents(match.id, [0, 1, 2, 3].map(seq => ({ turn_index: seq, seq, type: 'E', actor_role: 'system', payload: {} })));
      expect((await repo.findEventsAfter(match.id, 1)).map(e => e.seq)).toEqual([2, 3]);
      expect(await repo.findEventsAfter(match.id, 3)).toEqual([]);
    });

    it('moves are removed with their match (cascade)', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      await repo.recordMove(match.id, { index: 0, actor: 'white', content: 'e2e4' }, []);
      await prisma.matchEvent.deleteMany({ where: { match_id: match.id } });
      await prisma.matchParticipant.deleteMany({ where: { match_id: match.id } });
      await prisma.match.delete({ where: { id: match.id } });
      expect(await prisma.matchMove.count({ where: { match_id: match.id } })).toBe(0);
    });

    it('a match played in many slices through Postgres equals the same match played in one go', async () => {
      for (const [game, roles, options] of [
        ['chess', ['white', 'black'], { maxPlies: 40 }],
        ['texas_holdem', ['seat1', 'seat2', 'seat3'], { playerCount: 3 }],
        ['blackjack', ['seat1', 'seat2'], { playerCount: 2 }]
      ] as Array<[string, string[], any]>) {
        const whole = await createMatch(game, roles, { seed: 321 }, 'openai');
        await runMatch(whole.id, options, mk());

        const sliced = await createMatch(game, roles, { seed: 321 }, 'openai');
        let clock = 0;
        const timed = mk({
          now: () => clock,
          moveTimeoutMs: 10_000,
          getAdapter: () => { const inner = scriptedAdapter(); return { generateMove: async (...a: Parameters<typeof inner.generateMove>) => { clock += 10_000; return inner.generateMove(...a); } }; }
        });
        let result: SliceResult = { done: false, status: 'yielded' };
        let slices = 0;
        while (!result.done && slices++ < 200) {
          result = await runMatchSlice(sliced.id, options, timed, { deadlineAt: clock + 20_000 }); // 2 model calls per slice
        }
        expect(result.status).toBe('completed');

        const a = await repo.findById(whole.id);
        const b = await repo.findById(sliced.id);
        const strip = (rows: any[]) => rows.map(e => ({ seq: e.seq, type: e.type, actor: e.actor_role, turn: e.turn_index, payload: e.payload }));
        expect(strip(b!.events)).toEqual(strip(a!.events));
        expect(b!.participants.map(p => p.score)).toEqual(a!.participants.map(p => p.score));
        expect(await repo.getMoves(sliced.id)).toEqual(await repo.getMoves(whole.id));
        // a 40-ply chess game needs 40 model calls, so it genuinely spans 20 slices (short poker/blackjack hands may not)
        if (game === 'chess') expect((await prisma.match.findUnique({ where: { id: sliced.id } }))!.slice_count).toBe(20);
        expect((await prisma.match.findUnique({ where: { id: sliced.id } }))!.lease_owner).toBeNull();
      }
    });

    it('two real runners racing on one match produce one consistent game', async () => {
      const match = await createMatch('chess', ['white', 'black'], {}, 'openai');
      const results = await Promise.all([
        runMatchSlice(match.id, { maxPlies: 24 }, mk(), { owner: 'A' }),
        runMatchSlice(match.id, { maxPlies: 24 }, mk(), { owner: 'B' })
      ]);
      expect(results.map(r => r.status).sort()).toEqual(['busy', 'completed']);
      const row = await repo.findById(match.id);
      expect(row!.status).toBe('COMPLETED');
      expect(row!.events.map(e => e.seq)).toEqual(row!.events.map((_, i) => i));
      expect(await prisma.matchMove.count({ where: { match_id: match.id } })).toBe(24);
    });
  });

  describe('sweeper and admission (real SQL)', () => {
    const old = (ms: number) => new Date(Date.now() - ms);

    it('picks up orphaned matches, respects live leases, and expires an old backlog', async () => {
      const fresh = await createMatch('chess', ['white', 'black'], { created_at: old(60_000) });
      const tooFresh = await createMatch('chess', ['white', 'black'], { created_at: old(1_000) });
      const stale = await createMatch('chess', ['white', 'black'], { created_at: old(30 * 3_600_000) });
      const orphan = await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'dead', lease_expires_at: old(5_000) });
      const neverLeased = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' });
      const busy = await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'alive', lease_expires_at: new Date(Date.now() + 60_000) });
      const dispatch = jest.fn().mockResolvedValue(true);

      process.env.MATCH_RUNNER_CONCURRENCY = '1000';
      const result = await sweepMatches(new Date(), dispatch);
      const dispatched = new Map<string, boolean>(dispatch.mock.calls.map(([id, o]) => [id, o.continuation]));

      expect(dispatched.get(orphan.id)).toBe(true);        // resumed
      expect(dispatched.get(neverLeased.id)).toBe(true);
      expect(dispatched.get(fresh.id)).toBe(false);        // started as new
      expect(dispatched.has(tooFresh.id)).toBe(false);     // its own request is still dispatching it
      expect(dispatched.has(busy.id)).toBe(false);         // somebody is running it
      expect(dispatched.has(stale.id)).toBe(false);
      const expired = await prisma.match.findUnique({ where: { id: stale.id } });
      expect(expired).toMatchObject({ status: 'FAILED' });
      expect(expired!.failure_reason).toMatch(/Expired/);
      expect(result.expired).toBeGreaterThanOrEqual(1);
      delete process.env.MATCH_RUNNER_CONCURRENCY;
    });

    it('admission control counts only matches with a live lease', async () => {
      const before = await prisma.match.count({ where: { status: 'RUNNING', lease_expires_at: { gt: new Date() } } });
      await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'x', lease_expires_at: new Date(Date.now() + 60_000) });
      await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'y', lease_expires_at: old(1000) });
      process.env.MATCH_RUNNER_CONCURRENCY = String(before + 1);
      const target = await createMatch('chess', ['white', 'black']);
      const waitUntil = jest.fn();
      const deferred = await acceptSlice({ matchId: target.id, continuation: false }, waitUntil);
      expect(deferred.body).toMatchObject({ accepted: false, deferred: true });
      expect(waitUntil).not.toHaveBeenCalled();
      const continued = await acceptSlice({ matchId: target.id, continuation: true }, waitUntil);
      expect(continued.body).toEqual({ accepted: true });
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await waitUntil.mock.calls[0][0];
      delete process.env.MATCH_RUNNER_CONCURRENCY;
    });
  });

  describe('provider rate limiting (real SQL)', () => {
    const bucket = () => `test-${uid()}:rpm`;

    it('allows a burst, then denies with an accurate wait, then refills with time', async () => {
      const key = bucket();
      // 60/min = 1 per second, burst capacity 5 tokens
      const burst = [];
      for (let i = 0; i < 5; i++) burst.push(await takeFromBucket(key, 60, 1));
      expect(burst.every(r => r.allowed)).toBe(true);
      const denied: any = await takeFromBucket(key, 60, 1);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(1100);

      await prisma.$executeRaw`UPDATE "ProviderRateLimit" SET updated_at = updated_at - interval '2 seconds' WHERE "key" = ${key}`;
      expect((await takeFromBucket(key, 60, 1)).allowed).toBe(true);
      expect((await takeFromBucket(key, 60, 1)).allowed).toBe(true);
      expect((await takeFromBucket(key, 60, 1)).allowed).toBe(false);
    });

    it('under heavy concurrency never hands out more than the bucket holds', async () => {
      const key = bucket();
      const results = await Promise.all(Array.from({ length: 40 }, () => takeFromBucket(key, 60, 1)));
      expect(results.filter(r => r.allowed)).toHaveLength(5);
      const row = await prisma.providerRateLimit.findUnique({ where: { key } });
      expect(row!.tokens).toBeGreaterThanOrEqual(0);
    });

    it('a bucket never refills beyond its capacity', async () => {
      const key = bucket();
      await takeFromBucket(key, 60, 1);
      await prisma.$executeRaw`UPDATE "ProviderRateLimit" SET updated_at = updated_at - interval '1 hour' WHERE "key" = ${key}`;
      const results = [];
      for (let i = 0; i < 7; i++) results.push((await takeFromBucket(key, 60, 1)).allowed);
      expect(results.filter(Boolean)).toHaveLength(5); // capacity, not an hour of accrued tokens
    });

    it('an oversized request is clamped to the bucket and still admitted', async () => {
      const key = bucket();
      expect((await takeFromBucket(key, 60, 1_000_000)).allowed).toBe(true); // 5-token bucket (60/min), 1M-token request
      expect((await takeFromBucket(key, 60, 1)).allowed).toBe(false);        // and it emptied the bucket (refill is 1/s, far slower than this test)
    });

    it('buckets are independent per key', async () => {
      const a = bucket();
      const b = bucket();
      for (let i = 0; i < 5; i++) await takeFromBucket(a, 60, 1);
      expect((await takeFromBucket(a, 60, 1)).allowed).toBe(false);
      expect((await takeFromBucket(b, 60, 1)).allowed).toBe(true);
    });

    it('the provider-level limiter composes request and token buckets from the environment', async () => {
      const provider = `prov${uid()}`;
      process.env[`PROVIDER_RPM_${provider.toUpperCase()}`] = '60';
      process.env[`PROVIDER_TPM_${provider.toUpperCase()}`] = '6000';
      const limiter = createDbRateLimiter();
      expect((await limiter.acquire(provider, 400)).allowed).toBe(true);
      const second: any = await limiter.acquire(provider, 400); // token bucket (500) cannot cover another 400
      expect(second.allowed).toBe(false);
      expect(second.retryAfterMs).toBeGreaterThan(0);
      delete process.env[`PROVIDER_RPM_${provider.toUpperCase()}`];
      delete process.env[`PROVIDER_TPM_${provider.toUpperCase()}`];
    });
  });

  describe('usage accounting (real SQL)', () => {
    it('stores per-move provider, latency and tokens, and accumulates match totals atomically', async () => {
      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING' }, 'openai');
      const usage = (n: number) => ({ provider: 'openai', latencyMs: 100 * n, inputTokens: 1000 * n, outputTokens: 10 * n });
      await repo.recordMove(match.id, { index: 0, actor: 'white', content: 'e2e4', usage: usage(1) }, []);
      await repo.recordMove(match.id, { index: 1, actor: 'black', content: 'e7e5', usage: usage(2) }, []);
      await repo.recordMove(match.id, { index: 2, actor: 'system', content: 'RESOLVE' }, []); // engine move: no usage
      const row = await prisma.match.findUnique({ where: { id: match.id } });
      expect(row).toMatchObject({ input_tokens: 3000, output_tokens: 30 });
      const moves = await prisma.matchMove.findMany({ where: { match_id: match.id }, orderBy: { move_index: 'asc' } });
      expect(moves.map(m => [m.provider, m.latency_ms, m.input_tokens])).toEqual([['openai', 100, 1000], ['openai', 200, 2000], [null, null, null]]);
    });

    it('markStarted stamps once; addRateLimitWait counts', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      await repo.markStarted(match.id);
      const first = (await prisma.match.findUnique({ where: { id: match.id } }))!.started_at;
      expect(first).not.toBeNull();
      await new Promise(resolve => setTimeout(resolve, 15));
      await repo.markStarted(match.id);
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.started_at!.getTime()).toBe(first!.getTime());
      await repo.addRateLimitWait(match.id);
      await repo.addRateLimitWait(match.id);
      expect((await prisma.match.findUnique({ where: { id: match.id } }))!.rate_limit_waits).toBe(2);
    });

    it('a real run records usage and a start time, and a tiny token budget fails it', async () => {
      const mkDeps = (extra: any = {}) => ({ repo: repo as unknown as RunnerRepo, getEngine: getGameEngine, getAdapter: () => scriptedAdapter(), maxTurns: 600, sleep: async () => undefined, metric: () => undefined, ...extra });
      const ok = await createMatch('chess', ['white', 'black'], {}, 'openai');
      await runMatch(ok.id, { maxPlies: 24 }, mkDeps());
      const done = await prisma.match.findUnique({ where: { id: ok.id } });
      expect(done!.started_at).not.toBeNull();
      expect(done!.input_tokens).toBeGreaterThan(0);
      expect(await prisma.matchMove.count({ where: { match_id: ok.id, provider: 'openai' } })).toBe(24);

      const over = await createMatch('chess', ['white', 'black'], {}, 'openai');
      const result = await runMatchSlice(over.id, { maxPlies: 100 }, mkDeps({ maxInputTokens: 500 }));
      expect(result.status).toBe('failed');
      const failed = await prisma.match.findUnique({ where: { id: over.id } });
      expect(failed).toMatchObject({ status: 'FAILED' });
      expect(failed!.failure_reason).toMatch(/token budget/);
      expect(failed!.lease_owner).toBeNull();
    });
  });

  describe('runner health stats (real SQL)', () => {
    it('summarises queue depth, leases, outcomes, budgets, throttling and per-provider latency', async () => {
      const tag = `stat${uid()}`;
      const now = new Date();
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const base = await getRunnerStats(now);

      await createMatch('chess', ['white', 'black'], { created_at: ago(20 * 60_000) });                                   // pending, 20 min old
      await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'x', lease_expires_at: new Date(now.getTime() + 60_000), started_at: ago(90 * 60_000), slice_count: 4 });
      await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'dead', lease_expires_at: ago(60_000) }); // orphaned
      await createMatch('chess', ['white', 'black'], { status: 'COMPLETED', finished_at: ago(60_000), slice_count: 3, rate_limit_waits: 2 });
      await createMatch('chess', ['white', 'black'], { status: 'FAILED', finished_at: ago(60_000), failure_reason: 'Exceeded the time budget of 240 minutes', rate_limit_waits: 1 });
      await createMatch('chess', ['white', 'black'], { status: 'CANCELLED', finished_at: ago(60_000) });
      await createMatch('chess', ['white', 'black'], { status: 'COMPLETED', finished_at: ago(3 * 24 * 3_600_000) });        // too old to count

      const match = await createMatch('chess', ['white', 'black'], { status: 'RUNNING', lease_owner: 'y', lease_expires_at: new Date(now.getTime() + 60_000) }, 'openai');
      for (const [i, latency] of [100, 200, 300, 400, 1000].entries()) {
        await repo.recordMove(match.id, { index: i, actor: 'white', content: 'x', usage: { provider: tag, latencyMs: latency, inputTokens: 1000, outputTokens: 10 } }, []);
      }
      await prisma.matchMove.create({ data: { match_id: match.id, move_index: 99, actor_role: 'white', content: 'old', provider: tag, latency_ms: 99999, created_at: ago(2 * 3_600_000) } }); // outside the hour

      const stats = await getRunnerStats(now);
      expect(stats.pending - base.pending).toBe(1);
      expect(stats.oldestPendingMinutes).toBeGreaterThanOrEqual(20);
      expect(stats.runningLeased - base.runningLeased).toBe(2); // the one above plus the move-data match below
      expect(stats.runningOrphaned - base.runningOrphaned).toBe(1);
      expect(stats.completed24h - base.completed24h).toBe(1);
      expect(stats.failed24h - base.failed24h).toBe(1);
      expect(stats.cancelled24h - base.cancelled24h).toBe(1);
      expect(stats.budgetFailures24h - base.budgetFailures24h).toBe(1);
      expect(stats.throttleWaits24h - base.throttleWaits24h).toBe(3);
      const provider = stats.providers.find(p => p.provider === tag)!;
      expect(provider).toMatchObject({ calls: 5, p50Ms: 300, inputTokens: 5000, outputTokens: 50 });
      expect(provider.p95Ms).toBe(880); // interpolated: 400 + 0.8 * (1000 - 400); the 99,999 ms call from two hours ago is excluded
      expect(stats.longestRunning[0].minutes).toBeGreaterThanOrEqual(90);
      expect(stats.longestRunning[0].slices).toBe(4);
    });
  });

  describe('concurrency soak (real SQL)', () => {
    it('60 matches played at once in tiny slices all finish, each exactly once and in order', async () => {
      const games: Array<[string, string[], any]> = [
        ['chess', ['white', 'black'], { maxPlies: 30 }],
        ['texas_holdem', ['seat1', 'seat2', 'seat3'], { playerCount: 3 }],
        ['blackjack', ['seat1', 'seat2'], { playerCount: 2 }],
        ['chutes_and_ladders', ['player1'], {}]
      ];
      const created: Array<{ game: string; options: any; match: Awaited<ReturnType<typeof createMatch>> }> = [];
      for (let i = 0; i < 60; i++) {
        const [game, roles, options] = games[i % games.length];
        created.push({ game, options, match: await createMatch(game, roles, { seed: 1000 + i }, 'openai') });
      }

      const playOne = async ({ match, options }: (typeof created)[number]) => {
        let clock = 0;
        const d = {
          repo: repo as unknown as RunnerRepo, getEngine: getGameEngine, maxTurns: 600, sleep: async () => undefined, metric: () => undefined,
          now: () => clock, moveTimeoutMs: 10_000,
          getAdapter: () => { const inner = scriptedAdapter(); return { generateMove: async (...a: Parameters<typeof inner.generateMove>) => { clock += 10_000; return inner.generateMove(...a); } }; }
        };
        let result: SliceResult = { done: false, status: 'yielded' };
        let guard = 0;
        while (!result.done && guard++ < 300) {
          result = await runMatchSlice(match.id, options, d, { deadlineAt: clock + 20_000 });
        }
        return result;
      };

      const started = Date.now();
      const results = await Promise.all(created.map(playOne));
      const elapsed = Date.now() - started;

      expect(results.every(r => r.status === 'completed')).toBe(true);
      for (const { match } of created) {
        const row = await repo.findById(match.id);
        expect(row!.status).toBe('COMPLETED');
        expect(row!.events.map(e => e.seq)).toEqual(row!.events.map((_, i) => i)); // no gaps, no interleaving
        const moves = await repo.getMoves(match.id);
        expect(moves.map(m => m.move_index)).toEqual(moves.map((_, i) => i));
        expect((await prisma.match.findUnique({ where: { id: match.id } }))!.lease_owner).toBeNull();
      }
      // The whole soak is a smoke signal, not a benchmark: 60 matches should not take minutes even on a single-connection database.
      expect(elapsed).toBeLessThan(60_000);
    }, 120000);
  });

  describe('production seed (real process, real SQL)', () => {
    let workdir: string;
    beforeAll(() => {
      // seed.prod.js expects ../dist/constants/rbac-permissions.js; build just that file instead of the whole project.
      workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
      fs.mkdirSync(path.join(workdir, 'prisma'));
      fs.mkdirSync(path.join(workdir, 'dist', 'constants'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', '..', 'prisma', 'seed.prod.js'), path.join(workdir, 'prisma', 'seed.prod.js'));
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'constants', 'rbac-permissions.ts'), 'utf8');
      fs.writeFileSync(path.join(workdir, 'dist', 'constants', 'rbac-permissions.js'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
      fs.symlinkSync(path.join(__dirname, '..', '..', 'node_modules'), path.join(workdir, 'node_modules'));
    });
    afterAll(() => { fs.rmSync(workdir, { recursive: true, force: true }); });

    // The in-process test database accepts a single connection, so release ours while the seed process uses it.
    const seed = async (env: Record<string, string | undefined>) => {
      await prisma.$disconnect();
      await new Promise(resolve => setTimeout(resolve, 150));
      const merged: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined, ADMIN_TIER: undefined, ...env };
      Object.keys(merged).forEach(k => merged[k] === undefined && delete merged[k]);
      return spawnSync('node', ['prisma/seed.prod.js'], { cwd: workdir, env: merged, encoding: 'utf8', timeout: 90_000 });
    };
    const bcrypt = jest.requireActual('bcrypt');
    const strong = 'correct-horse-battery-staple-91';

    it('refuses to create an admin without an explicit strong password (no hardcoded default)', async () => {
      const email = `nopw-${uid()}@example.com`;
      for (const password of [undefined, '', 'admin123', 'short-pw']) {
        const result = await seed({ ADMIN_EMAIL: email, ADMIN_PASSWORD: password });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('ADMIN_PASSWORD (at least 12 characters) is required');
      }
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });

    it('creates the first admin with the SuperAdmin role, all permissions, and the built-in mock model', async () => {
      const email = `admin-${uid()}@example.com`;
      const result = await seed({ ADMIN_EMAIL: email, ADMIN_PASSWORD: strong });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const admin = await prisma.user.findUnique({ where: { email }, include: { rbac_roles: { include: { role: true } } } as any }) as any;
      expect(admin).toMatchObject({ role: 'ADMIN', tier: 'ENTERPRISE', email_verified: true });
      expect(await bcrypt.compare(strong, admin.password_hash)).toBe(true);
      expect(admin.password_hash).not.toContain(strong);
      const superAdmin = await prisma.rbacRole.findUnique({ where: { name: 'SuperAdmin' } });
      expect(await prisma.rbacUserRole.count({ where: { user_id: admin.id, role_id: superAdmin!.id } })).toBe(1);
      expect(await prisma.rbacRolePermission.count({ where: { role_id: superAdmin!.id, effect: 'ALLOW' } })).toBe(RBAC_PERMISSIONS.length);
      expect(await prisma.rbacRole.count({ where: { name: { in: ['ContentAdmin', 'SupportAdmin', 'OpsAdmin'] } } })).toBe(3);
      expect(await prisma.model.count({ where: { api_provider: 'mock', api_model_id: 'mock-random' } })).toBe(1);
    });

    it('is idempotent: re-running never resets the password, duplicates data, or needs the password again', async () => {
      const email = `again-${uid()}@example.com`;
      expect((await seed({ ADMIN_EMAIL: email, ADMIN_PASSWORD: strong })).status).toBe(0);
      const before = (await prisma.user.findUnique({ where: { email } }))!.password_hash!;

      const rerunWithOtherPassword = await seed({ ADMIN_EMAIL: email, ADMIN_PASSWORD: 'a-completely-different-password-1' });
      expect(rerunWithOtherPassword.status).toBe(0);
      expect((await prisma.user.findUnique({ where: { email } }))!.password_hash).toBe(before);

      expect((await seed({ ADMIN_EMAIL: email })).status).toBe(0); // existing admin: no password needed
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(await prisma.model.count({ where: { api_provider: 'mock', api_model_id: 'mock-random' } })).toBe(1);
      expect(await prisma.rbacRole.count({ where: { name: 'SuperAdmin' } })).toBe(1);
    });

    it('a second, different admin email still needs its own password', async () => {
      const result = await seed({ ADMIN_EMAIL: `second-${uid()}@example.com` });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('required to create the first admin');
    });

    it('honours ADMIN_TIER', async () => {
      const email = `tier-${uid()}@example.com`;
      expect((await seed({ ADMIN_EMAIL: email, ADMIN_PASSWORD: strong, ADMIN_TIER: 'PRO' })).status).toBe(0);
      expect((await prisma.user.findUnique({ where: { email } }))!.tier).toBe('PRO');
    });
  });

  describe('session store (real SQL, real express-session)', () => {
    const makeApp = () => {
      const app = express();
      app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, store: new PrismaSessionStore() }));
      const big = '<html><body>' + 'x'.repeat(60_000) + '</body></html>\n';
      app.get('/page', (req, res) => { (req.session as any).visits = ((req.session as any).visits || 0) + 1; res.send(big); });
      app.get('/visits', (req, res) => { res.json({ visits: (req.session as any).visits || 0 }); });
      app.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
      return { app, big };
    };
    const serve = async (app: express.Express) => {
      const server = http.createServer(app);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    };
    const get = (base: string, path: string, cookie?: string, method = 'GET') => new Promise<{ status: number; body: string; length: string | undefined; cookie: string | undefined }>((resolve, reject) => {
      const req = http.request(base + path, { method, headers: cookie ? { cookie } : {}, timeout: 8000 }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), length: res.headers['content-length'], cookie: (res.headers['set-cookie'] || [])[0]?.split(';')[0] }));
      });
      req.on('timeout', () => { req.destroy(new Error('response stalled')); });
      req.on('error', reject);
      req.end();
    });

    it('delivers every byte of a response that modifies the session (the production stall)', async () => {
      const { app, big } = makeApp();
      const { server, base } = await serve(app);
      try {
        const res = await get(base, '/page');
        expect(res.status).toBe(200);
        expect(res.body).toBe(big);                       // complete, including the final byte express-session holds back
        expect(Buffer.byteLength(res.body)).toBe(Number(res.length));
        expect(res.cookie).toMatch(/^connect\.sid=/);
      } finally { server.close(); }
    });

    it('keeps the session across separate app instances, as on serverless cold starts', async () => {
      const first = await serve(makeApp().app);
      let cookie: string;
      try {
        cookie = (await get(first.base, '/page')).cookie!;
        await get(first.base, '/page', cookie);
      } finally { first.server.close(); }
      const second = await serve(makeApp().app);                  // a different instance with an empty memory
      try {
        expect(JSON.parse((await get(second.base, '/visits', cookie!)).body)).toEqual({ visits: 2 });
        expect(await prisma.httpSession.count()).toBeGreaterThanOrEqual(1);
      } finally { second.server.close(); }
    });

    it('logout destroys the session for everyone', async () => {
      const { app } = makeApp();
      const { server, base } = await serve(app);
      try {
        const cookie = (await get(base, '/page')).cookie!;
        await get(base, '/logout', cookie, 'POST');
        expect(JSON.parse((await get(base, '/visits', cookie)).body)).toEqual({ visits: 0 });
      } finally { server.close(); }
    });

    it('expired sessions are not honoured and are removed', async () => {
      const store = new PrismaSessionStore();
      const sid = `expired-${uid()}`;
      await prisma.httpSession.create({ data: { sid, sess: { cookie: {}, userId: 'ghost' }, expire: new Date(Date.now() - 1000) } });
      const result = await new Promise<any>(resolve => store.get(sid, (_e, r) => resolve(r)));
      expect(result).toBeNull();
      expect(await prisma.httpSession.count({ where: { sid } })).toBe(0);
    });

    it('a tampered cookie is rejected without touching other sessions', async () => {
      const { app } = makeApp();
      const { server, base } = await serve(app);
      try {
        const cookie = (await get(base, '/page')).cookie!;
        const forged = cookie.replace(/\.[^.]+$/, '.forgedsignature');
        expect(JSON.parse((await get(base, '/visits', forged)).body)).toEqual({ visits: 0 });
      } finally { server.close(); }
    });
  });
  describe('event hash chain columns (real SQL, generated Prisma client)', () => {
    const HASH = 'ab'.repeat(32);
    const PREV = '01'.repeat(32);

    it('round-trips a hash pair and leaves it null on the existing runner write path', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      // the runner's own write path (unchanged until story m1-03) stores no hashes
      await repo.addEvents(match.id, [{ turn_index: 0, seq: 0, type: 'START', actor_role: 'system', payload: {} }]);
      await prisma.matchEvent.create({ data: { match_id: match.id, turn_index: 1, seq: 1, type: 'STEP', actor_role: 'player1', payload: { n: 1 }, hash: HASH, prev_hash: PREV } });

      const rows = await repo.findEventsAfter(match.id, -1);
      expect(rows.map(r => r.seq)).toEqual([0, 1]);
      expect(rows[0]).toMatchObject({ hash: null, prev_hash: null });
      expect(rows[1]).toMatchObject({ hash: HASH, prev_hash: PREV });
    });

    it('rejects a malformed or half-present pair', async () => {
      const match = await createMatch('chess', ['white', 'black']);
      const data = { match_id: match.id, turn_index: 0, seq: 0, type: 'STEP', actor_role: 'player1', payload: {} };
      await expect(prisma.matchEvent.create({ data: { ...data, hash: 'NOT-A-HASH', prev_hash: PREV } })).rejects.toThrow();
      await expect(prisma.matchEvent.create({ data: { ...data, hash: HASH } })).rejects.toThrow();
      expect(await prisma.matchEvent.count({ where: { match_id: match.id } })).toBe(0);
    });
  });
});
