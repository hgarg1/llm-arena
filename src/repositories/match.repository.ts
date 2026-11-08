import { prisma } from '../config/db';
import { Match, MatchStatus, Prisma } from '@prisma/client';
import { isDatabaseConfigured } from '../config/runtime';
import { chainAppend, ChainTail } from '../integrity/append';

export interface MoveUsage {
  provider: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Thrown when another runner already recorded the move we were about to record (our lease was lost). */
export class LeaseLostError extends Error {
  constructor(message = 'Match lease was lost to another runner') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class MatchRepository {
  async create(data: Prisma.MatchCreateInput): Promise<Match> {
    if (!isDatabaseConfigured()) {
      throw new Error('Database is not configured');
    }
    return prisma.match.create({ data });
  }

  async findById(id: string) {
    if (!isDatabaseConfigured()) {
      return null;
    }
    return prisma.match.findUnique({
      where: { id },
      include: {
        participants: { include: { model: true } },
        events: { orderBy: [{ seq: 'asc' }, { turn_index: 'asc' }, { created_at: 'asc' }] },
        tournament: true
      }
    });
  }

  /** Everything a runner needs, without the (potentially large) event list. */
  async findForRun(id: string) {
    if (!isDatabaseConfigured()) return null;
    return prisma.match.findUnique({
      where: { id },
      include: { participants: { include: { model: true } } }
    });
  }

  async findEventsAfter(id: string, afterSeq: number) {
    if (!isDatabaseConfigured()) return [];
    return prisma.matchEvent.findMany({
      where: { match_id: id, seq: { gt: afterSeq } },
      orderBy: [{ seq: 'asc' }, { turn_index: 'asc' }, { created_at: 'asc' }]
    });
  }

  /**
   * Atomically takes (or renews after expiry) the right to run a match. Returns false when another
   * runner holds a live lease or the match is not in an allowed state.
   */
  async acquireLease(id: string, owner: string, ttlMs: number, statuses: MatchStatus[]): Promise<boolean> {
    if (!isDatabaseConfigured()) return false;
    const now = new Date();
    const result = await prisma.match.updateMany({
      where: {
        id,
        status: { in: statuses },
        OR: [{ lease_owner: null }, { lease_expires_at: null }, { lease_expires_at: { lt: now } }, { lease_owner: owner }]
      },
      data: { lease_owner: owner, lease_expires_at: new Date(now.getTime() + ttlMs), slice_count: { increment: 1 } }
    });
    return result.count > 0;
  }

  /** Extends our lease. False means we lost it or the match is no longer RUNNING (e.g. cancelled). */
  async renewLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    if (!isDatabaseConfigured()) return false;
    const result = await prisma.match.updateMany({
      where: { id, lease_owner: owner, status: MatchStatus.RUNNING },
      data: { lease_expires_at: new Date(Date.now() + ttlMs) }
    });
    return result.count > 0;
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    if (!isDatabaseConfigured()) return;
    await prisma.match.updateMany({ where: { id, lease_owner: owner }, data: { lease_owner: null, lease_expires_at: null } });
  }

  async getMoves(id: string) {
    if (!isDatabaseConfigured()) return [];
    return prisma.matchMove.findMany({
      where: { match_id: id },
      orderBy: { move_index: 'asc' },
      select: { move_index: true, actor_role: true, content: true }
    });
  }

  async countEvents(id: string): Promise<number> {
    if (!isDatabaseConfigured()) return 0;
    return prisma.matchEvent.count({ where: { match_id: id } });
  }

  /**
   * Records a move and the events it produced in one transaction. The unique (match, move_index) key
   * makes this exactly-once: if two runners race, the loser gets LeaseLostError and writes nothing.
   */
  async recordMove(
    id: string,
    move: { index: number; actor: string; content: string; usage?: MoveUsage },
    events: { turn_index: number; seq: number; type: string; actor_role: string; payload: any }[]
  ): Promise<void> {
    if (!isDatabaseConfigured()) return;
    try {
      // One interactive transaction: the move row goes first, so a runner that lost the race fails on the unique
      // (match, move_index) key before it touches the event log. The hash chain is then extended from the tail that
      // is really stored, and the unique (match, prev_hash) index rejects any second successor.
      await prisma.$transaction(async tx => {
        await tx.matchMove.create({
          data: {
            match_id: id,
            move_index: move.index,
            actor_role: move.actor,
            content: move.content,
            provider: move.usage?.provider ?? null,
            latency_ms: move.usage?.latencyMs ?? null,
            input_tokens: move.usage?.inputTokens ?? null,
            output_tokens: move.usage?.outputTokens ?? null
          }
        });
        if (events.length > 0) await this.appendEventsIn(tx, id, events);
        await tx.match.update({
          where: { id },
          data: {
            move_failures: 0,
            ...(move.usage ? { input_tokens: { increment: move.usage.inputTokens }, output_tokens: { increment: move.usage.outputTokens } } : {})
          }
        });
      }, { timeout: 20_000, maxWait: 10_000 });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new LeaseLostError();
      throw err;
    }
  }

  /** Appends events to a match's hash chain inside the caller's transaction (see src/integrity/append.ts). */
  private async appendEventsIn(
    tx: Prisma.TransactionClient,
    matchId: string,
    events: { turn_index: number; seq: number; type: string; actor_role: string | null; payload: any }[]
  ) {
    const last = await tx.matchEvent.findFirst({
      where: { match_id: matchId },
      orderBy: [{ seq: 'desc' }, { turn_index: 'desc' }, { created_at: 'desc' }],
      select: { seq: true, hash: true }
    });
    const tail: ChainTail | null = last ? { seq: last.seq, hash: last.hash } : null;
    const rows = chainAppend(matchId, tail, events);
    return tx.matchEvent.createMany({ data: rows.map(e => ({ match_id: matchId, ...e, payload: e.payload as Prisma.InputJsonValue })) });
  }

  /** Counts a failed model call for the current move and returns the new consecutive-failure count. */
  async recordMoveFailure(id: string): Promise<number> {
    if (!isDatabaseConfigured()) return 0;
    const row = await prisma.match.update({ where: { id }, data: { move_failures: { increment: 1 } }, select: { move_failures: true } });
    return row.move_failures;
  }

  /** Stamps the first start of a match (idempotent); the wall-time budget counts from here. */
  async markStarted(id: string): Promise<void> {
    if (!isDatabaseConfigured()) return;
    await prisma.match.updateMany({ where: { id, started_at: null }, data: { started_at: new Date() } });
  }

  async addRateLimitWait(id: string): Promise<void> {
    if (!isDatabaseConfigured()) return;
    await prisma.match.update({ where: { id }, data: { rate_limit_waits: { increment: 1 } } });
  }

  async resetMoveFailures(id: string) {
    if (!isDatabaseConfigured()) return;
    await prisma.match.update({ where: { id }, data: { move_failures: 0 } });
  }

  async setRulesetVersion(id: string, version: string) {
    if (!isDatabaseConfigured()) return;
    await prisma.match.update({ where: { id }, data: { ruleset_version: version } });
  }

  async findAll(options?: { search?: string; gameType?: string; status?: MatchStatus; page?: number; limit?: number }) {
    if (!isDatabaseConfigured()) {
      const page = options?.page || 1;
      const limit = options?.limit || 20;
      return { matches: [], total: 0, page, limit, totalPages: 0 };
    }

    const where: Prisma.MatchWhereInput = {};
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    if (options?.gameType) {
        where.game_type = options.gameType;
    }

    if (options?.status) {
        where.status = options.status;
    }

    if (options?.search) {
        // Search by Match ID or Participant Model Name
        where.OR = [
            { id: { contains: options.search, mode: 'insensitive' } },
            { participants: { some: { model: { name: { contains: options.search, mode: 'insensitive' } } } } }
        ];
    }

    const [matches, total] = await Promise.all([
        prisma.match.findMany({
            where,
            include: {
                participants: { include: { model: true } },
                tournament: true
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: limit
        }),
        prisma.match.count({ where })
    ]);

    return { matches, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateStatus(id: string, status: MatchStatus, finishedAt?: Date, failureReason?: string | null) {
    if (!isDatabaseConfigured()) {
      return null;
    }
    return prisma.match.update({
      where: { id },
      data: {
        status,
        finished_at: finishedAt ?? null,
        ...(failureReason !== undefined ? { failure_reason: failureReason } : {})
      }
    });
  }

  async getStatus(id: string): Promise<MatchStatus | null> {
    if (!isDatabaseConfigured()) return null;
    const row = await prisma.match.findUnique({ where: { id }, select: { status: true } });
    return row?.status ?? null;
  }

  /**
   * Moves a match to `to` only if it is still in one of the `from` states. Returns false when someone else
   * (e.g. an admin cancelling it) already moved it, so a late finish can never overwrite a cancellation.
   */
  async transitionStatus(id: string, from: MatchStatus[], to: MatchStatus, finishedAt?: Date, failureReason?: string | null): Promise<boolean> {
    if (!isDatabaseConfigured()) return false;
    const result = await prisma.match.updateMany({
      where: { id, status: { in: from } },
      data: {
        status: to,
        finished_at: finishedAt ?? null,
        ...(failureReason !== undefined ? { failure_reason: failureReason } : {})
      }
    });
    return result.count > 0;
  }

  async clearEvents(matchId: string) {
    if (!isDatabaseConfigured()) return null;
    return prisma.matchEvent.deleteMany({ where: { match_id: matchId } });
  }

  async addEvents(matchId: string, events: { turn_index: number; seq: number; type: string; actor_role: string; payload: any }[]) {
    if (!isDatabaseConfigured() || events.length === 0) return null;
    try {
      return await prisma.$transaction(tx => this.appendEventsIn(tx, matchId, events), { timeout: 20_000, maxWait: 10_000 });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new LeaseLostError();
      throw err;
    }
  }

  async setParticipantScore(participantId: string, score: number) {
    if (!isDatabaseConfigured()) return null;
    return prisma.matchParticipant.update({ where: { id: participantId }, data: { score } });
  }

  async addEvent(data: Prisma.MatchEventCreateInput) {
    if (!isDatabaseConfigured()) {
      return null;
    }
    const matchId = data.match?.connect?.id;
    if (!matchId) return prisma.matchEvent.create({ data }); // no match to chain under
    await this.addEvents(matchId, [{
      turn_index: data.turn_index,
      seq: data.seq ?? 0,
      type: data.type,
      actor_role: data.actor_role ?? 'system',
      payload: data.payload
    }]);
    return null;
  }
}
