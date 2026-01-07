import { ModelAdapter, GameEvent } from './types';

export class MockChutesModelAdapter implements ModelAdapter {
  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    return "I acknowledge the roll.";
  }
}
