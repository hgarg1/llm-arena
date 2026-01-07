import { IteratedNegotiationGame } from './negotiation';
import { ChessGame } from './chess';
import { ChutesLaddersGame } from './chutes_ladders';
import { TexasHoldemGame } from './poker';
import { BlackjackGame } from './blackjack';
import { GameEngine } from './types';

export const getGameEngine = async (gameType: string): Promise<GameEngine> => {
  if (gameType === 'chess') return new ChessGame();
  if (gameType === 'chutes_and_ladders') return new ChutesLaddersGame();
  if (gameType === 'texas_holdem') return new TexasHoldemGame();
  if (gameType === 'blackjack') return new BlackjackGame();

  try {
    const module = await import(`./generated/${gameType}`);
    if (module?.default) return new module.default();
  } catch (err) {
    // Ignore and fall back
  }

  return new IteratedNegotiationGame();
};
