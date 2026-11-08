import { MatchStatus } from '@prisma/client';
import { LeaseLostError, MoveUsage } from '../../src/repositories/match.repository';
import { RunnerEventRow, RunnerMatch, RunnerRepo, StoredMove } from '../../src/services/match-runner.service';
import { chainAppend, ChainTail } from '../../src/integrity/append';

export type StoredEvent = RunnerEventRow & { hash: string | null; prev_hash: string | null };

/** In-memory implementation of the runner's repository with the same semantics as the SQL one. */
export class MemoryRepo implements RunnerRepo {
  status: MatchStatus;
  leaseOwner: string | null = null;
  leaseExpiresAt = 0;
  sliceCount = 0;
  moveFailures = 0;
  moves: StoredMove[] = [];
  events: StoredEvent[] = [];
  scores: Record<string, number> = {};
  statusLog: Array<{ status: MatchStatus; reason?: string | null }> = [];
  rulesetVersion: string | null = null;
  startedAt: Date | null = null;
  inputTokens = 0;
  outputTokens = 0;
  rateLimitWaits = 0;
  usage: MoveUsage[] = [];

  constructor(public match: RunnerMatch, initial: MatchStatus = MatchStatus.PENDING, public clock: () => number = Date.now) {
    this.status = initial;
  }

  /** The stored event with the highest seq, as the SQL repository reads it inside its transaction. */
  private tail(): ChainTail | null {
    if (this.events.length === 0) return null;
    const last = this.events.reduce((a, b) => (b.seq >= a.seq ? b : a));
    return { seq: last.seq, hash: last.hash };
  }

  private set(status: MatchStatus, reason?: string | null) {
    this.status = status;
    this.statusLog.push({ status, reason });
  }

  async findForRun() { return { ...this.match, status: this.status, move_failures: this.moveFailures, started_at: this.startedAt, input_tokens: this.inputTokens, output_tokens: this.outputTokens }; }
  async markStarted() { if (!this.startedAt) this.startedAt = new Date(this.clock()); }
  async addRateLimitWait() { this.rateLimitWaits++; }
  async updateStatus(_id: string, status: MatchStatus, _at?: Date, reason?: string | null) { this.set(status, reason); }
  async getStatus() { return this.status; }
  async transitionStatus(_id: string, from: MatchStatus[], to: MatchStatus, _at?: Date, reason?: string | null) {
    if (!from.includes(this.status)) return false;
    this.set(to, reason);
    return true;
  }
  async clearEvents() { this.events = []; }
  async addEvents(_id: string, events: RunnerEventRow[]) { this.events.push(...chainAppend(this.match.id, this.tail(), events) as StoredEvent[]); }
  async setParticipantScore(participantId: string, score: number) { this.scores[participantId] = score; }
  async acquireLease(_id: string, owner: string, ttlMs: number, statuses: MatchStatus[]) {
    const free = !this.leaseOwner || this.leaseExpiresAt < this.clock() || this.leaseOwner === owner;
    if (!statuses.includes(this.status) || !free) return false;
    this.leaseOwner = owner;
    this.leaseExpiresAt = this.clock() + ttlMs;
    this.sliceCount++;
    return true;
  }
  async renewLease(_id: string, owner: string, ttlMs: number) {
    if (this.leaseOwner !== owner || this.status !== MatchStatus.RUNNING) return false;
    this.leaseExpiresAt = this.clock() + ttlMs;
    return true;
  }
  async releaseLease(_id: string, owner: string) {
    if (this.leaseOwner === owner) { this.leaseOwner = null; this.leaseExpiresAt = 0; }
  }
  async getMoves() { return [...this.moves]; }
  async countEvents() { return this.events.length; }
  async recordMove(_id: string, move: { index: number; actor: string; content: string; usage?: MoveUsage }, events: RunnerEventRow[]) {
    if (this.moves.some(m => m.move_index === move.index)) throw new LeaseLostError();
    this.moves.push({ move_index: move.index, actor_role: move.actor, content: move.content });
    if (move.usage) { this.usage.push(move.usage); this.inputTokens += move.usage.inputTokens; this.outputTokens += move.usage.outputTokens; }
    this.events.push(...chainAppend(this.match.id, this.tail(), events) as StoredEvent[]);
    this.moveFailures = 0;
  }
  async recordMoveFailure() { return ++this.moveFailures; }
  async resetMoveFailures() { this.moveFailures = 0; }
  async setRulesetVersion(_id: string, version: string) { this.rulesetVersion = version; }

  // Test controls
  cancel() { this.status = MatchStatus.CANCELLED; this.statusLog.push({ status: MatchStatus.CANCELLED }); }
  stealLease(other = 'someone-else') { this.leaseOwner = other; this.leaseExpiresAt = this.clock() + 600_000; }
}

export const participants = (provider: string, roles: string[]) =>
  roles.map((role, i) => ({ id: `p${i + 1}`, role, model: { api_provider: provider, api_model_id: `m${i + 1}` } }));
