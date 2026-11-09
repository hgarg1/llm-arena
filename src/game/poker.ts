/// <reference path="../types/pokersolver.d.ts" />
import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';
import { Hand } from 'pokersolver';

type Street = 'preflop' | 'flop' | 'turn' | 'river';

type Seat = {
  id: string;
  stack: number;
  folded: boolean;
  allIn: boolean;
  holeCards: string[];
  /** Chips committed on the current street. */
  currentBet: number;
  /** Chips committed over the whole hand. */
  contributed: number;
};

/**
 * Single-hand no-limit Texas Hold'em.
 *
 * Betting is a real state machine: a street ends once every player who can still act has acted since
 * the last raise and matched the highest bet. All-in players are handled with side pots, and when
 * nobody can act any more the board is run out to showdown.
 */
export class TexasHoldemGame implements GameEngine {
  gameType = 'texas_holdem';
  private deck: string[] = [];
  private rngState: number;
  private players: Seat[] = [];
  private communityCards: string[] = [];
  private street: Street = 'preflop';
  private dealerIndex = 0;
  private toAct = 0;
  private acted = new Set<number>();
  private highBet = 0;
  private lastRaiseSize = 10;
  private handOver = false;
  /** True when nobody can act any more (all-in blinds) and the engine just needs to run the board out. */
  private autoResolve = false;
  private smallBlind = 5;
  private bigBlind = 10;
  private startingStack = 1000;

  constructor() {
    this.rngState = 1;
  }

  // Deterministic RNG (LCG)
  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return this.rngState;
  }

  private randInt(n: number): number {
    return (this.rand() >>> 8) % n;
  }

  private shuffleDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    this.deck = [];
    for (const s of suits) {
      for (const r of ranks) {
        this.deck.push(r + s);
      }
    }
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = this.randInt(i + 1);
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  private drawCard(): string {
    const card = this.deck.pop();
    if (!card) throw new Error('Deck exhausted');
    return card;
  }

  private get pot(): number {
    return this.players.reduce((sum, p) => sum + p.contributed, 0);
  }

  private commit(index: number, amount: number) {
    const p = this.players[index];
    const paid = Math.max(0, Math.min(amount, p.stack));
    p.stack -= paid;
    p.currentBet += paid;
    p.contributed += paid;
    if (p.stack === 0) p.allIn = true;
    return paid;
  }

  initialize(seed: number, options?: { playerCount?: number; dealerIndex?: number; startingStack?: number; smallBlind?: number; bigBlind?: number }): GameEvent[] {
    this.rngState = seed >>> 0;
    this.shuffleDeck();

    const playerCount = Math.max(2, Math.min(9, Math.floor(options?.playerCount || 2)));
    this.startingStack = options?.startingStack && options.startingStack > 0 ? Math.floor(options.startingStack) : 1000;
    this.smallBlind = options?.smallBlind && options.smallBlind > 0 ? Math.floor(options.smallBlind) : 5;
    this.bigBlind = options?.bigBlind && options.bigBlind > 0 ? Math.floor(options.bigBlind) : 10;
    if (this.bigBlind < this.smallBlind) this.bigBlind = this.smallBlind;

    this.communityCards = [];
    this.street = 'preflop';
    this.handOver = false;
    this.acted = new Set();
    this.highBet = 0;
    this.lastRaiseSize = this.bigBlind;

    if (options?.dealerIndex !== undefined && options.dealerIndex >= 0 && options.dealerIndex < playerCount) {
      this.dealerIndex = options.dealerIndex;
    } else {
      this.dealerIndex = this.randInt(playerCount);
    }

    this.players = [];
    for (let i = 0; i < playerCount; i++) {
      this.players.push({ id: `seat${i + 1}`, stack: this.startingStack, folded: false, allIn: false, holeCards: [], currentBet: 0, contributed: 0 });
    }

    const events: GameEvent[] = [
      {
        turn: 0,
        actor: 'system',
        type: 'MATCH_START',
        payload: {
          game_key: 'texas_holdem',
          seed,
          ruleset_version: '2.0.0',
          engine_version: '2.0.0',
          player_count: playerCount,
          blind_structure: { small: this.smallBlind, big: this.bigBlind },
          starting_stack: this.startingStack,
          dealer_seat: this.dealerIndex + 1
        }
      }
    ];

    this.players.forEach((p, i) => {
      const c1 = this.drawCard();
      const c2 = this.drawCard();
      p.holeCards = [c1, c2];
      events.push({ turn: 0, actor: 'system', type: 'DEAL_HOLE_CARDS', payload: { seat: i + 1, cards: [c1, c2] } });
    });

    // Heads-up: the dealer is the small blind and acts first preflop.
    const sbIndex = playerCount === 2 ? this.dealerIndex : (this.dealerIndex + 1) % playerCount;
    const bbIndex = playerCount === 2 ? (this.dealerIndex + 1) % 2 : (this.dealerIndex + 2) % playerCount;
    const firstActionIndex = playerCount === 2 ? this.dealerIndex : (this.dealerIndex + 3) % playerCount;

    const sbPaid = this.commit(sbIndex, this.smallBlind);
    const bbPaid = this.commit(bbIndex, this.bigBlind);
    this.highBet = Math.max(sbPaid, bbPaid);

    events.push({
      turn: 0,
      actor: 'system',
      type: 'POST_BLINDS',
      payload: { sb_seat: sbIndex + 1, bb_seat: bbIndex + 1, amounts: [sbPaid, bbPaid] }
    });
    events.push({ turn: 0, actor: 'system', type: 'BETTING_ROUND_START', payload: { round: 'preflop' } });

    this.toAct = firstActionIndex;
    // A blind that is already all-in cannot act; find the first seat that can.
    if (this.players[this.toAct].allIn) {
      this.toAct = this.nextToAct(this.toAct) ?? this.toAct;
    }
    const canAct = this.players.filter(p => !p.allIn);
    this.autoResolve = canAct.length === 0 || (canAct.length === 1 && canAct[0].currentBet >= this.highBet);
    return events;
  }

  private buildStatus(role: string): string {
    const idx = this.players.findIndex(p => p.id === role);
    if (idx < 0) return '';
    const p = this.players[idx];
    const toCall = Math.max(0, this.highBet - p.currentBet);
    const minRaiseTo = this.highBet + this.lastRaiseSize;
    return [
      `Your hole cards: ${p.holeCards.join(' ')}.`,
      `Board: ${this.communityCards.length ? this.communityCards.join(' ') : '(none yet)'} (${this.street}).`,
      `Pot: ${this.pot}. Your stack: ${p.stack}. To call: ${toCall}. Minimum raise-to: ${Math.min(minRaiseTo, p.stack + p.currentBet)}.`
    ].join(' ');
  }

  getSystemPrompt(role: string): string {
    return `You are playing No-Limit Texas Hold'em as ${role}. Your hole cards are private; the board is public. ` +
      `Reply with exactly one action: FOLD, CHECK, CALL, RAISE <total bet to raise to>, or ALL-IN. ` +
      `An invalid action is treated as a fold. ${this.buildStatus(role)}`;
  }

  getActiveRole(): string | null {
    if (this.handOver) return null;
    if (this.autoResolve) return 'system';
    return this.players[this.toAct]?.id ?? null;
  }

  getObservation(history: GameEvent[], role: string): GameEvent[] {
    const seat = /^seat(\d+)$/.exec(role);
    const ownSeat = seat ? parseInt(seat[1], 10) : -1;
    return history.filter(e => e.type !== 'DEAL_HOLE_CARDS' || e.payload?.seat === ownSeat);
  }

  getRandomMove(_gameState: GameEvent[], role: string): PlayerMove {
    const p = this.players.find(pl => pl.id === role);
    if (!p) return { actor: role, content: 'FOLD' };
    const toCall = Math.max(0, this.highBet - p.currentBet);
    const roll = this.randInt(100);
    if (toCall === 0) {
      return { actor: role, content: roll < 85 ? 'CHECK' : 'RAISE' };
    }
    if (roll < 65) return { actor: role, content: 'CALL' };
    if (roll < 90) return { actor: role, content: 'FOLD' };
    return { actor: role, content: 'RAISE' };
  }

  /** Next seat after `from` (clockwise) that still has a decision to make on this street. */
  private nextToAct(from: number): number | null {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + step) % n;
      const p = this.players[i];
      if (p.folded || p.allIn) continue;
      if (!this.acted.has(i) || p.currentBet < this.highBet) return i;
    }
    return null;
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[]; result: GameResult | null } {
    if (this.handOver) throw new Error('Hand is already over');
    const turnIndex = (history[history.length - 1]?.turn ?? 0) + 1;
    const events: GameEvent[] = [];
    if (this.autoResolve) {
      this.autoResolve = false;
      this.acted = new Set(this.players.map((_, i) => i));
      return this.advance(events, turnIndex, this.dealerIndex);
    }
    const seatIdx = this.toAct;
    const player = this.players[seatIdx];
    if (move.actor !== player.id) {
      throw new Error(`Out of turn: ${move.actor} acted while ${player.id} was to act`);
    }

    const raw = String(move.content || '').toUpperCase().trim();
    const parts = raw.split(/\s+/);
    const word = parts[0].replace(/[^A-Z-]/g, '');
    const action = word === 'ALLIN' || word === 'ALL-IN' || word === 'ALL' ? 'ALLIN' : word;
    const parsedAmount = parts.length > 1 ? parseInt(parts[1].replace(/[^0-9]/g, ''), 10) : NaN;

    const toCall = Math.max(0, this.highBet - player.currentBet);
    const maxRaiseTo = player.stack + player.currentBet;
    const minRaiseTo = this.highBet + this.lastRaiseSize;

    let performed: { action: string; amount: number } | null = null;

    if (action === 'FOLD') {
      player.folded = true;
      performed = { action: 'fold', amount: 0 };
    } else if (action === 'CHECK' && toCall === 0) {
      performed = { action: 'check', amount: 0 };
    } else if (action === 'CALL') {
      if (toCall === 0) {
        performed = { action: 'check', amount: 0 };
      } else {
        const paid = this.commit(seatIdx, toCall);
        performed = { action: player.allIn ? 'all-in' : 'call', amount: paid };
      }
    } else if (action === 'BET' || action === 'RAISE' || action === 'ALLIN') {
      let raiseTo = action === 'ALLIN'
        ? maxRaiseTo
        : (Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : minRaiseTo);
      raiseTo = Math.max(raiseTo, minRaiseTo);
      raiseTo = Math.min(raiseTo, maxRaiseTo);
      if (raiseTo <= this.highBet) {
        // Cannot afford to raise: this is a call (possibly all-in).
        if (toCall === 0) {
          performed = { action: 'check', amount: 0 };
        } else {
          const paid = this.commit(seatIdx, toCall);
          performed = { action: player.allIn ? 'all-in' : 'call', amount: paid };
        }
      } else {
        const paid = this.commit(seatIdx, raiseTo - player.currentBet);
        const size = player.currentBet - this.highBet;
        if (size >= this.lastRaiseSize) this.lastRaiseSize = size;
        this.highBet = player.currentBet;
        // A raise re-opens the action for everyone else.
        this.acted = new Set();
        performed = { action: player.allIn ? 'all-in' : (toCall === 0 && this.street !== 'preflop' ? 'bet' : 'raise'), amount: paid };
        // Report the raise-to amount so the log is readable.
        (performed as any).raise_to = player.currentBet;
      }
    }

    if (!performed) {
      player.folded = true;
      events.push({
        turn: turnIndex,
        actor: move.actor,
        type: 'ILLEGAL_ACTION',
        payload: { seat: seatIdx + 1, raw_action: raw, fallback: 'FOLD' }
      });
      events.push({
        turn: turnIndex,
        actor: move.actor,
        type: 'PLAYER_ACTION',
        payload: { seat: seatIdx + 1, action: 'fold', amount: 0, stack_after: player.stack }
      });
    } else {
      events.push({
        turn: turnIndex,
        actor: move.actor,
        type: 'PLAYER_ACTION',
        payload: {
          seat: seatIdx + 1,
          action: performed.action,
          amount: performed.amount,
          ...((performed as any).raise_to !== undefined ? { raise_to: (performed as any).raise_to } : {}),
          stack_after: player.stack,
          pot: this.pot
        }
      });
    }
    this.acted.add(seatIdx);

    return this.advance(events, turnIndex, seatIdx);
  }

  private advance(events: GameEvent[], turnIndex: number, from: number): { events: GameEvent[]; result: GameResult | null } {
    for (;;) {
      const alive = this.players.filter(p => !p.folded);
      if (alive.length === 1) {
        return this.finishByFold(events, turnIndex, alive[0]);
      }

      const next = this.nextToAct(from);
      if (next !== null) {
        this.toAct = next;
        return { events, result: null };
      }

      // Street complete.
      if (this.street === 'river') {
        return this.finishAtShowdown(events, turnIndex);
      }
      this.dealNextStreet(events, turnIndex);

      const canAct = this.players.filter(p => !p.folded && !p.allIn);
      if (canAct.length < 2) {
        // Nobody left to bet against: run the board out.
        from = this.dealerIndex;
        this.acted = new Set(this.players.map((_, i) => i));
        continue;
      }
      events.push({ turn: turnIndex, actor: 'system', type: 'BETTING_ROUND_START', payload: { round: this.street } });
      // Post-flop action starts with the first live seat left of the dealer.
      from = this.dealerIndex;
    }
  }

  private dealNextStreet(events: GameEvent[], turnIndex: number) {
    const draw = (n: number) => Array.from({ length: n }, () => this.drawCard());
    if (this.street === 'preflop') {
      this.street = 'flop';
      const cards = draw(3);
      this.communityCards.push(...cards);
      events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_COMMUNITY', payload: { round: 'flop', cards } });
    } else if (this.street === 'flop') {
      this.street = 'turn';
      const cards = draw(1);
      this.communityCards.push(...cards);
      events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_COMMUNITY', payload: { round: 'turn', cards } });
    } else if (this.street === 'turn') {
      this.street = 'river';
      const cards = draw(1);
      this.communityCards.push(...cards);
      events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_COMMUNITY', payload: { round: 'river', cards } });
    }
    this.players.forEach(p => { p.currentBet = 0; });
    this.highBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.acted = new Set();
  }

  private buildResult(events: GameEvent[], turnIndex: number, extra: Record<string, any>) {
    const finalStacks = this.players.map(p => p.stack);
    const scores: Record<string, number> = {};
    this.players.forEach(p => {
      scores[p.id] = p.stack > this.startingStack ? 1 : p.stack === this.startingStack ? 0.5 : 0;
    });
    const top = Math.max(...finalStacks);
    const leaders = this.players.filter(p => p.stack === top);
    const winnerId = leaders.length === 1 ? leaders[0].id : undefined;
    this.handOver = true;
    events.push({
      turn: turnIndex,
      actor: 'system',
      type: 'RESULT',
      payload: { winner_seat: winnerId ? parseInt(winnerId.slice(4), 10) : 'split', final_stacks: finalStacks, total_hands: 1, ...extra }
    });
    return { events, result: { isFinished: true, scores, winnerId } as GameResult };
  }

  private finishByFold(events: GameEvent[], turnIndex: number, winner: Seat) {
    const amount = this.pot;
    winner.stack += amount;
    events.push({ turn: turnIndex, actor: 'system', type: 'POT_AWARDED', payload: { seat: this.players.indexOf(winner) + 1, amount } });
    return this.buildResult(events, turnIndex, { reason: 'fold' });
  }

  private finishAtShowdown(events: GameEvent[], turnIndex: number) {
    const live = this.players.map((p, i) => ({ p, i })).filter(x => !x.p.folded);
    const solved = new Map<number, any>();
    live.forEach(({ p, i }) => solved.set(i, Hand.solve(p.holeCards.concat(this.communityCards))));

    events.push({
      turn: turnIndex,
      actor: 'system',
      type: 'SHOWDOWN',
      payload: {
        hands: live.map(({ p, i }) => ({ seat: i + 1, cards: p.holeCards, rank: solved.get(i).name }))
      }
    });

    // Side pots: one layer per distinct contribution level of the players still in the hand.
    const levels = Array.from(new Set(live.map(({ p }) => p.contributed))).sort((a, b) => a - b);
    let previous = 0;
    for (const level of levels) {
      const potAmount = this.players.reduce(
        (sum, p) => sum + Math.max(0, Math.min(p.contributed, level) - previous),
        0
      );
      previous = level;
      const eligible = live.filter(({ p }) => p.contributed >= level);
      if (potAmount === 0 || eligible.length === 0) continue;
      const winnerHands = Hand.winners(eligible.map(({ i }) => solved.get(i)));
      const winners = eligible.filter(({ i }) => winnerHands.includes(solved.get(i)));
      const share = Math.floor(potAmount / winners.length);
      let remainder = potAmount - share * winners.length;
      // Odd chips go to the winners closest to the left of the dealer.
      const ordered = [...winners].sort(
        (a, b) => ((a.i - this.dealerIndex - 1 + this.players.length) % this.players.length) - ((b.i - this.dealerIndex - 1 + this.players.length) % this.players.length)
      );
      ordered.forEach(({ p, i }) => {
        const amount = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        p.stack += amount;
        events.push({ turn: turnIndex, actor: 'system', type: 'POT_AWARDED', payload: { seat: i + 1, amount } });
      });
    }

    return this.buildResult(events, turnIndex, { reason: 'showdown' });
  }
}
