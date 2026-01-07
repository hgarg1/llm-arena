import { GameEngine, GameEvent, GameResult, PlayerMove } from './types';

type BlackjackHand = {
  cards: string[];
  status: 'active' | 'stand' | 'bust' | 'surrendered';
  bet: number;
  actions_taken: number;
  is_split_ace: boolean;
  is_split: boolean;
  doubled: boolean;
};

export class BlackjackGame implements GameEngine {
  gameType = 'blackjack';
  private deck: string[] = [];
  private rngState: number;
  private players: {
    id: string;
    stack: number;
    hands: BlackjackHand[];
    insurance_bet: number;
    insurance_taken: boolean;
  }[] = [];
  private dealerHand: string[] = [];
  private dealerRevealed = false;
  private activeSeatIndex = 0;
  private activeHandIndex = 0;
  private turnPhase: 'dealing' | 'players' | 'dealer' | 'payout' = 'dealing';
  
  // Config
  private fixedBet = 10;
  private playerCount = 1;
  private startingStack = 1000;
  private dealerHitsSoft17 = false;
  private allowDouble = true;
  private allowDoubleAny = false;
  private allowInsurance = false;
  private allowSurrender = false;
  private blackjackPayout = 1.5;
  private deckCount = 1;
  private allowSplit = false;
  private maxHands = 4;
  private allowResplitAces = false;
  private allowDoubleAfterSplit = false;
  private dealerPeek = false;
  private noHoleCard = false;

  constructor() {
    this.rngState = 1;
  }

  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) % 4294967296;
    return Math.abs(this.rngState);
  }

  private shuffleDeck() {
    const suits = ['h', 'd', 'c', 's'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    this.deck = [];
    for (let d = 0; d < this.deckCount; d++) {
        for (const s of suits) {
            for (const r of ranks) {
                this.deck.push(r + s);
            }
        }
    }
    // Fisher-Yates
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = this.rand() % (i + 1);
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
  }

  private drawCard(): string {
    return this.deck.pop() || '';
  }

  private getHandValue(cards: string[]): number {
    return this.getHandValueWithSoft(cards).value;
  }

  private getHandValueWithSoft(cards: string[]): { value: number; soft: boolean } {
    let value = 0;
    let aces = 0;
    for (const card of cards) {
      const rank = card.slice(0, -1);
      if (['T', 'J', 'Q', 'K'].includes(rank)) value += 10;
      else if (rank === 'A') { value += 11; aces++; }
      else value += parseInt(rank);
    }
    while (value > 21 && aces > 0) {
      value -= 10;
      aces--;
    }
    return { value, soft: aces > 0 };
  }

  private getActivePlayer() {
    return this.players[this.activeSeatIndex];
  }

  private getActiveHand(): BlackjackHand | undefined {
    const player = this.getActivePlayer();
    return player ? player.hands[this.activeHandIndex] : undefined;
  }

  private canSplit(hand: { cards: string[]; is_split_ace: boolean }, player: { hands: { cards: string[] }[] }) {
    if (!this.allowSplit) return false;
    if (player.hands.length >= this.maxHands) return false;
    if (hand.cards.length !== 2) return false;
    const rankA = hand.cards[0]?.slice(0, -1);
    const rankB = hand.cards[1]?.slice(0, -1);
    if (!rankA || !rankB) return false;
    if (rankA !== rankB) return false;
    if (rankA === 'A' && hand.is_split_ace && !this.allowResplitAces) return false;
    return true;
  }

  initialize(seed: number, options?: { playerCount?: number; fixedBet?: number; startingStack?: number; dealerHitsSoft17?: boolean; allowDouble?: boolean; allowDoubleAny?: boolean; allowInsurance?: boolean; allowSurrender?: boolean; blackjackPayout?: number; deckCount?: number; allowSplit?: boolean; maxHands?: number; allowResplitAces?: boolean; allowDoubleAfterSplit?: boolean; dealerPeek?: boolean; noHoleCard?: boolean }): GameEvent[] {
    this.rngState = seed;
    this.deckCount = Math.max(1, Math.min(8, options?.deckCount || this.deckCount));
    this.shuffleDeck();
    this.playerCount = options?.playerCount || 1;
    this.fixedBet = Math.max(1, options?.fixedBet || this.fixedBet);
    this.startingStack = Math.max(1, options?.startingStack || this.startingStack);
    this.fixedBet = Math.min(this.fixedBet, this.startingStack);
    this.dealerHitsSoft17 = options?.dealerHitsSoft17 === true;
    this.allowDouble = options?.allowDouble !== false;
    this.allowDoubleAny = options?.allowDoubleAny === true;
    this.allowInsurance = options?.allowInsurance === true;
    this.allowSurrender = options?.allowSurrender === true;
    this.blackjackPayout = Math.max(1, Math.min(2, options?.blackjackPayout || this.blackjackPayout));
    this.allowSplit = options?.allowSplit === true;
    this.maxHands = Math.max(2, Math.min(6, options?.maxHands || this.maxHands));
    this.allowResplitAces = options?.allowResplitAces === true;
    this.allowDoubleAfterSplit = options?.allowDoubleAfterSplit === true;
    this.dealerPeek = options?.dealerPeek === true;
    this.noHoleCard = options?.noHoleCard === true;
    if (this.noHoleCard) {
        this.dealerPeek = false;
        this.allowInsurance = false;
    }
    this.players = [];
    
    // Init players
    for (let i = 0; i < this.playerCount; i++) {
        this.players.push({ 
            id: `seat${i+1}`, 
            stack: this.startingStack - this.fixedBet, 
            hands: [{
                cards: [],
                status: 'active',
                bet: this.fixedBet,
                actions_taken: 0,
                is_split_ace: false,
                is_split: false,
                doubled: false
            }],
            insurance_bet: 0,
            insurance_taken: false
        });
    }

    const events: GameEvent[] = [{
        turn: 0,
        actor: 'system',
        type: 'MATCH_START',
        payload: {
            game_key: 'blackjack',
            seed,
            ruleset_version: '1.0.0',
            player_count: this.playerCount,
            fixed_bet: this.fixedBet,
            starting_stack: this.startingStack,
            dealer_hits_soft_17: this.dealerHitsSoft17,
            allow_double: this.allowDouble,
            allow_double_any: this.allowDoubleAny,
            allow_insurance: this.allowInsurance,
            allow_surrender: this.allowSurrender,
            blackjack_payout: this.blackjackPayout,
            deck_count: this.deckCount,
            allow_split: this.allowSplit,
            max_hands: this.maxHands,
            allow_resplit_aces: this.allowResplitAces,
            allow_double_after_split: this.allowDoubleAfterSplit,
            dealer_peek: this.dealerPeek,
            no_hole_card: this.noHoleCard
        }
    }];

    // Deal Initial Hands
    // Order: Player 1, Player 2... Player N, Dealer, Player 1...
    // Standard casino deal: 1 to each player, 1 to dealer, 1 to each player, 1 to dealer (hole)
    
    // Card 1
    this.players.forEach((p, i) => {
        const c = this.drawCard();
        p.hands[0].cards.push(c);
        events.push({ turn: 0, actor: 'system', type: 'DEAL_CARD', payload: { seat: i + 1, card: c, visibility: 'private' } });
    });
    
    // Dealer Card 1 (Visible)
    const d1 = this.drawCard();
    this.dealerHand.push(d1);
    events.push({ turn: 0, actor: 'system', type: 'DEAL_DEALER', payload: { cards: [d1], visibility: 'visible' } });

    // Card 2
    this.players.forEach((p, i) => {
        const c = this.drawCard();
        p.hands[0].cards.push(c);
        events.push({ turn: 0, actor: 'system', type: 'DEAL_CARD', payload: { seat: i + 1, card: c, visibility: 'private' } });
    });

    // Dealer Card 2 (Hole)
    if (!this.noHoleCard) {
        const d2 = this.drawCard();
        this.dealerHand.push(d2);
        // Don't emit reveal yet
    }
    
    this.turnPhase = 'players';
    this.activeSeatIndex = 0;
    this.activeHandIndex = 0;

    if (this.dealerPeek && !this.noHoleCard && this.dealerHand.length === 2) {
        const upRank = this.dealerHand[0]?.slice(0, -1);
        const upIsTen = ['T', 'J', 'Q', 'K'].includes(upRank || '');
        if (upRank === 'A' || upIsTen) {
            const dealerVal = this.getHandValue(this.dealerHand);
            if (dealerVal === 21) {
                this.turnPhase = 'dealer';
            }
        }
    }

    return events;
  }

  getSystemPrompt(role: string): string {
    const seatIdx = parseInt(role.replace('seat', '')) - 1;
    const p = this.players[seatIdx];
    const hand = p?.hands[this.activeHandIndex];
    if (!p || !hand) return 'Blackjack state unavailable.';
    const val = this.getHandValue(hand.cards);
    const canDoubleBase = (this.allowDouble && hand.cards.length === 2) || this.allowDoubleAny;
    const canDouble = canDoubleBase && (this.allowDoubleAfterSplit || !hand.is_split);
    const canInsure = this.allowInsurance && !this.noHoleCard && this.dealerHand[0]?.startsWith('A') && !p.insurance_taken && hand.actions_taken === 0 && this.activeHandIndex === 0;
    const canSurrender = this.allowSurrender && hand.cards.length === 2 && hand.actions_taken === 0;
    const canSplit = this.canSplit(hand, p);
    
    return `You are playing Blackjack.
Your Hand: ${hand.cards.join(', ')} (Value: ${val}).
Dealer Shows: ${this.dealerHand[0]}.
Your Stack: ${p.stack}.
Actions: HIT, STAND${canDouble ? ', DOUBLE' : ''}${canSplit ? ', SPLIT' : ''}${canInsure ? ', INSURE' : ''}${canSurrender ? ', SURRENDER' : ''}.
Reply with ONE word.`;
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[], result: GameResult | null } {
    const turnIndex = history.length; // Approximate logic
    const events: GameEvent[] = [];
    
    if (this.turnPhase !== 'players') {
        // Should be dealer phase or payout
        // If worker calls this, it's a mistake, but we handle dealer logic here automatically?
        // Worker calls processMove with 'dealer' actor? 
        // No, worker loops players.
        // We need to auto-resolve dealer if phase is dealer.
        return this.resolveDealer(turnIndex);
    }

    const seatIdx = this.activeSeatIndex;
    const p = this.players[seatIdx];
    const hand = this.getActiveHand();
    if (!p || !hand) {
        return { events, result: null };
    }
    
    // Parse Action
    let action = move.content.trim().toUpperCase();
    const canInsure = this.allowInsurance && !this.noHoleCard && this.dealerHand[0]?.startsWith('A') && !p.insurance_taken && hand.actions_taken === 0 && this.activeHandIndex === 0;
    const canSurrender = this.allowSurrender && hand.cards.length === 2 && hand.actions_taken === 0;
    const canDoubleBase = (this.allowDouble && hand.cards.length === 2) || this.allowDoubleAny;
    const canDouble = canDoubleBase && (this.allowDoubleAfterSplit || !hand.is_split);
    const canSplit = this.canSplit(hand, p);

    if (action === 'INSURE' && canInsure) {
        const insurance = Math.min(Math.floor(hand.bet / 2), p.stack);
        p.stack -= insurance;
        p.insurance_bet = insurance;
        p.insurance_taken = true;
        events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'insurance', amount: insurance } });
        return { events, result: null };
    }

    if (action === 'SURRENDER' && canSurrender) {
        hand.status = 'surrendered';
        hand.actions_taken += 1;
        const refund = Math.floor(hand.bet / 2);
        p.stack += refund;
        events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'surrender' } });
        this.handleHandEnd(events, turnIndex, seatIdx, 'surrendered');
        return { events, result: null };
    }

    if (action === 'SPLIT' && canSplit) {
        if (p.stack < this.fixedBet) {
            action = 'STAND';
        } else {
            p.stack -= this.fixedBet;
            const secondCard = hand.cards.pop() as string;
            const splitAce = secondCard.startsWith('A');
            const newHand: BlackjackHand = {
                cards: [secondCard],
                status: 'active' as const,
                bet: this.fixedBet,
                actions_taken: 0,
                is_split_ace: splitAce,
                is_split: true,
                doubled: false
            };
            hand.is_split = true;
            hand.is_split_ace = hand.is_split_ace || splitAce;
            hand.actions_taken += 1;

            const c1 = this.drawCard();
            const c2 = this.drawCard();
            hand.cards.push(c1);
            newHand.cards.push(c2);
            p.hands.splice(this.activeHandIndex + 1, 0, newHand);

            events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'split' } });
            events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_CARD', payload: { seat: seatIdx + 1, card: c1, hand_index: this.activeHandIndex } });
            events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_CARD', payload: { seat: seatIdx + 1, card: c2, hand_index: this.activeHandIndex + 1 } });

            if (hand.is_split_ace && !this.allowResplitAces) {
                hand.status = 'stand';
                newHand.status = 'stand';
                events.push({ turn: turnIndex, actor: 'system', type: 'HAND_END', payload: { seat: seatIdx + 1, hand_index: this.activeHandIndex, result: 'stand' } });
                events.push({ turn: turnIndex, actor: 'system', type: 'HAND_END', payload: { seat: seatIdx + 1, hand_index: this.activeHandIndex + 1, result: 'stand' } });
                this.finishSeat(events, turnIndex, seatIdx, 'stand');
            }

            return { events, result: null };
        }
    }

    if (!['HIT', 'STAND', 'DOUBLE'].includes(action)) action = 'STAND'; // Fallback
    
    // Logic
    if (action === 'HIT') {
        const c = this.drawCard();
        hand.cards.push(c);
        events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'hit' } });
        events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_CARD', payload: { seat: seatIdx + 1, card: c, hand_index: this.activeHandIndex } });
        hand.actions_taken += 1;
        
        const val = this.getHandValue(hand.cards);
        if (val > 21) {
            hand.status = 'bust';
            this.handleHandEnd(events, turnIndex, seatIdx, 'bust');
        }
        // If not bust, turn continues (same seat)
    } else if (action === 'STAND') {
        hand.status = 'stand';
        events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'stand' } });
        hand.actions_taken += 1;
        this.handleHandEnd(events, turnIndex, seatIdx, 'stand');
    } else if (action === 'DOUBLE') {
        if (canDouble && p.stack >= this.fixedBet) {
            p.stack -= this.fixedBet;
            hand.bet *= 2;
            const c = this.drawCard();
            hand.cards.push(c);
            events.push({ turn: turnIndex, actor: move.actor, type: 'PLAYER_ACTION', payload: { seat: seatIdx + 1, action: 'double' } });
            events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_CARD', payload: { seat: seatIdx + 1, card: c, hand_index: this.activeHandIndex } });
            hand.actions_taken += 1;
            hand.doubled = true;
            
            const val = this.getHandValue(hand.cards);
            if (val > 21) hand.status = 'bust';
            else hand.status = 'stand';
            
            this.handleHandEnd(events, turnIndex, seatIdx, hand.status);
        } else {
            // Illegal double, treat as HIT
            return this.processMove(history, { ...move, content: 'HIT' });
        }
    }

    // Check if all players done
    if (this.activeSeatIndex >= this.playerCount) {
        this.turnPhase = 'dealer';
        // Immediately resolve dealer
        const dealerRes = this.resolveDealer(turnIndex + events.length);
        events.push(...dealerRes.events);
        return { events, result: dealerRes.result };
    }

    return { events, result: null };
  }

  private handleHandEnd(events: GameEvent[], turnIndex: number, seatIdx: number, result: string, silentAdvance: boolean = false) {
      const p = this.players[seatIdx];
      if (!p) return;
      events.push({ turn: turnIndex, actor: 'system', type: 'HAND_END', payload: { seat: seatIdx + 1, hand_index: this.activeHandIndex, result } });

      const nextHandIndex = p.hands.findIndex((h, idx) => idx > this.activeHandIndex && h.status === 'active');
      if (nextHandIndex !== -1) {
          this.activeHandIndex = nextHandIndex;
          if (!silentAdvance) {
              events.push({ turn: turnIndex, actor: 'system', type: 'HAND_START', payload: { seat: seatIdx + 1, hand_index: this.activeHandIndex } });
          }
          return;
      }

      this.finishSeat(events, turnIndex, seatIdx, result);
  }

  private finishSeat(events: GameEvent[], turnIndex: number, seatIdx: number, result: string) {
      this.activeSeatIndex++;
      this.activeHandIndex = 0;
      events.push({ turn: turnIndex, actor: 'system', type: 'PLAYER_TURN_END', payload: { seat: seatIdx + 1, result } });
  }

  private resolveDealer(turnIndex: number): { events: GameEvent[], result: GameResult } {
      const events: GameEvent[] = [];
      
      if (this.noHoleCard && this.dealerHand.length === 1) {
          const hole = this.drawCard();
          this.dealerHand.push(hole);
          events.push({ turn: turnIndex, actor: 'system', type: 'DEAL_DEALER', payload: { cards: [hole], visibility: 'hidden' } });
      }

      // Reveal Hole
      this.dealerRevealed = true;
      events.push({ turn: turnIndex, actor: 'system', type: 'DEALER_REVEAL', payload: { cards: this.dealerHand } });
      
      let dealerInfo = this.getHandValueWithSoft(this.dealerHand);
      let dVal = dealerInfo.value;
      
      // Dealer Rules: Hit soft 16, Stand soft 17? Spec says "Dealer hits on soft 16, stands on soft 17".
      // Standard: Hit until >= 17. 
      // Soft 17 logic: If 17 and has Ace counted as 11, hit?
      // "Stands on soft 17" means if value is 17 (soft), dealer stops.
      // So dealer hits if value < 17.
      
      while (dVal < 17 || (this.dealerHitsSoft17 && dVal === 17 && dealerInfo.soft)) {
          const c = this.drawCard();
          this.dealerHand.push(c);
          dealerInfo = this.getHandValueWithSoft(this.dealerHand);
          dVal = dealerInfo.value;
          events.push({ turn: turnIndex, actor: 'system', type: 'DEALER_ACTION', payload: { action: 'hit', card: c, hand_value: dVal } });
      }
      events.push({ turn: turnIndex, actor: 'system', type: 'DEALER_ACTION', payload: { action: 'stand', hand_value: dVal } });

      // Payouts
      const scores: Record<string, number> = {};
      const dealerBust = dVal > 21;
      const dealerBJ = dVal === 21 && this.dealerHand.length === 2;

      this.players.forEach((p, i) => {
          let insuranceDelta = 0;
          if (p.insurance_bet > 0 && dealerBJ) {
              p.stack += p.insurance_bet * 3;
              insuranceDelta = p.insurance_bet * 2;
          }

          p.hands.forEach((hand, handIdx) => {
              const pVal = this.getHandValue(hand.cards);
              const pBJ = pVal === 21 && hand.cards.length === 2 && !hand.is_split;
              let outcome = 'loss';
              let delta = 0;

              if (hand.status === 'surrendered') {
                  outcome = 'surrender';
                  delta = -hand.bet / 2;
              } else if (hand.status === 'bust') {
                  outcome = 'bust';
                  delta = -hand.bet;
              } else if (pBJ && !dealerBJ) {
                  outcome = 'blackjack';
                  delta = hand.bet * this.blackjackPayout;
              } else if (dealerBJ && !pBJ) {
                  outcome = 'loss';
                  delta = -hand.bet;
              } else if (dealerBust) {
                  outcome = 'win';
                  delta = hand.bet;
              } else if (pVal > dVal) {
                  outcome = 'win';
                  delta = hand.bet;
              } else if (pVal === dVal) {
                  outcome = 'push';
                  delta = 0;
              } else {
                  outcome = 'loss';
                  delta = -hand.bet;
              }

              if (outcome !== 'loss' && outcome !== 'bust' && outcome !== 'surrender') {
                  p.stack += (hand.bet + delta); 
              }
              if (outcome === 'push') p.stack += hand.bet;

              events.push({
                  turn: turnIndex,
                  actor: 'system',
                  type: 'HAND_RESULT',
                  payload: { seat: i + 1, hand_index: handIdx, outcome, payout_delta: delta, insurance_delta: insuranceDelta, stack_after: p.stack }
              });
          });
          
          scores[p.id] = p.stack > this.startingStack ? 1 : (p.stack === this.startingStack ? 0.5 : 0);
      });

      return {
          events,
          result: {
              isFinished: true,
              scores, // ELO based on profitability?
              winnerId: undefined
          }
      };
  }
}
