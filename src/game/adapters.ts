import { ModelAdapter, GameEvent } from './types';

export class MockModelAdapter implements ModelAdapter {
  constructor(private deterministicMode: boolean = true) {}

  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    const turn = history.length;
    // Deterministic response based on history length
    if (turn % 2 === 0) {
        return `Turn ${turn}: I propose a 50/50 split.`;
    } else {
        return `Turn ${turn}: I accept your proposal.`;
    }
  }
}

export class OpenAIModelAdapter implements ModelAdapter {
  constructor(private apiKey: string, private modelId: string) {}

  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    // Placeholder for actual OpenAI call
    // In production, we would use 'openai' package
    console.log(`[OpenAI] Generating move with model ${this.modelId}`);
    return `[AI Generated] I am thinking about the offer... (Mock output for ${this.modelId})`;
  }
}

export function getModelAdapter(provider: string, modelId: string, apiKey?: string): ModelAdapter {
  if (provider === 'mock') {
    return new MockModelAdapter();
  } else if (provider === 'openai') {
    return new OpenAIModelAdapter(apiKey || '', modelId);
  }
  throw new Error(`Unknown provider: ${provider}`);
}
