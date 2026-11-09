import { ModelAdapter, GameEvent } from './types';

export class MockChutesModelAdapter implements ModelAdapter {
  async generateMove(_systemPrompt: string, _history: GameEvent[]): Promise<string> {
    return "I acknowledge the roll.";
  }
}
