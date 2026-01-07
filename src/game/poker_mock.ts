import { ModelAdapter, GameEvent } from './types';

export class MockPokerModelAdapter implements ModelAdapter {
  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    // Simple strategy: check or call, rarely bet
    const rand = Math.random();
    if (rand < 0.1) return "FOLD";
    if (rand < 0.6) return "CHECK"; // Will be parsed as CALL if check invalid
    if (rand < 0.9) return "CALL";
    return "RAISE 10";
  }
}
