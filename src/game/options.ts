/** Maps form/setting keys (snake_case) to the option names each built-in engine expects. */
export const mapOptionsToEngine = (gameType: string, options: Record<string, any>) => {
  if (gameType === 'chess') {
    return {
      startFen: options.start_fen,
      maxPlies: options.max_plies,
      allowDraws: options.allow_draws,
      timeControlMinutes: options.time_control_minutes,
      incrementSeconds: options.increment_seconds
    };
  }
  if (gameType === 'chutes_and_ladders') {
    return {
      boardSize: options.board_size,
      winExact: options.win_exact,
      chutesEnabled: options.chutes_enabled,
      laddersEnabled: options.ladders_enabled
    };
  }
  if (gameType === 'texas_holdem') {
    return {
      startingStack: options.starting_stack,
      smallBlind: options.small_blind,
      bigBlind: options.big_blind
    };
  }
  if (gameType === 'blackjack') {
    return {
      startingStack: options.starting_stack,
      fixedBet: options.fixed_bet,
      dealerHitsSoft17: options.dealer_hits_soft_17,
      allowDouble: options.allow_double,
      deckCount: options.deck_count,
      blackjackPayout: options.blackjack_payout,
      allowInsurance: options.allow_insurance,
      allowSurrender: options.allow_surrender,
      allowDoubleAny: options.allow_double_any,
      allowSplit: options.allow_split,
      maxHands: options.max_hands,
      allowResplitAces: options.allow_resplit_aces,
      allowDoubleAfterSplit: options.allow_double_after_split,
      dealerPeek: options.dealer_peek,
      noHoleCard: options.no_hole_card
    };
  }
  return options;
};
