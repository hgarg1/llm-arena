import { ModelAdapter, GameEvent } from './types';
import axios from 'axios';
import { prisma } from '../config/db';

export class MockModelAdapter implements ModelAdapter {
  constructor(private deterministicMode: boolean = true) {}

  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    const turn = history.length;
    if (turn % 2 === 0) {
        return `Turn ${turn}: I propose a 50/50 split.`;
    } else {
        return `Turn ${turn}: I accept your proposal.`;
    }
  }
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
      private apiKey: string, 
      private modelId: string, 
      private baseUrl: string = 'https://api.openai.com/v1',
      private headers: Record<string, string> = {}
  ) {}

  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(e => {
                const role = e.actor === 'assistant' ? 'assistant' : (e.actor === 'system' ? 'system' : 'user');
                
                // If there are images, use content array format (OpenAI Vision)
                if (e.payload.images && e.payload.images.length > 0) {
                    const content: any[] = [{ type: 'text', text: e.payload.content || JSON.stringify(e.payload) }];
                    e.payload.images.forEach((url: string) => {
                        content.push({ type: 'image_url', image_url: { url: url.startsWith('http') ? url : `data:image/jpeg;base64,${url}` } });
                    });
                    return { role, content };
                }

                return {
                    role,
                    content: e.payload.content || JSON.stringify(e.payload)
                };
            })
        ];

        const res = await axios.post(`${this.baseUrl}/chat/completions`, {
            model: this.modelId,
            messages: messages,
            temperature: 0 // Enforce determinism where possible
        }, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...this.headers
            }
        });

        return res.data.choices[0].message.content;
    } catch (error: any) {
        console.error(`[Adapter Error] ${this.modelId}:`, error.message);
        return `[Error] Failed to generate move: ${error.message}`;
    }
  }
}

export class AnthropicAdapter implements ModelAdapter {
    constructor(private apiKey: string, private modelId: string) {}
  
    async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
      try {
          // Anthropic Messages API
          const messages = history.map(e => ({
              role: e.actor === 'system' ? 'user' : 'user', // Anthropic strict roles: user/assistant
              content: JSON.stringify(e.payload)
          }));
          // Note: Anthropic system prompt is a top-level parameter, not a message
  
          const res = await axios.post('https://api.anthropic.com/v1/messages', {
              model: this.modelId,
              system: systemPrompt,
              messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Start game.' }],
              max_tokens: 1024,
              temperature: 0
          }, {
              headers: {
                  'x-api-key': this.apiKey,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json'
              }
          });
  
          return res.data.content[0].text;
      } catch (error: any) {
          console.error(`[Anthropic Error] ${this.modelId}:`, error.message);
          return `[Error] Failed to generate move: ${error.message}`;
      }
    }
}

export class GoogleAdapter implements ModelAdapter {
    constructor(private apiKey: string, private modelId: string) {}
  
    async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
      try {
          // Google Gemini API (generateContent)
          // Simplified: Concatenate history into a prompt or use multi-turn chat if supported cleanly
          // For MVP, we'll just prompt with context.
          
          const prompt = `${systemPrompt}\n\nHistory:\n${history.map(h => JSON.stringify(h.payload)).join('\n')}\n\nYour Move:`

          const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${this.modelId}:generateContent?key=${this.apiKey}`, {
              contents: [{
                  parts: [{ text: prompt }]
              }],
              generationConfig: {
                  temperature: 0
              }
          });
  
          return res.data.candidates[0].content.parts[0].text;
      } catch (error: any) {
          console.error(`[Google Error] ${this.modelId}:`, error.message);
          return `[Error] Failed to generate move: ${error.message}`;
      }
    }
}

export class CompositeAdapter implements ModelAdapter {
  private initialized = false;
  private adapters: { adapter: ModelAdapter; weight: number }[] = [];
  private pipeline: { adapter: ModelAdapter; promptTemplate?: string }[] = [];
  private strategy: 'ROUND_ROBIN' | 'RANDOM' | 'FALLBACK' | 'PIPELINE' = 'ROUND_ROBIN';
  private pointer = 0;

  constructor(private compositeModelId: string) {}

  private async ensureLoaded() {
    if (this.initialized) return;
    const composite = await prisma.modelComposite.findUnique({
      where: { model_id: this.compositeModelId },
      include: {
        members: {
          include: { member: true },
          orderBy: { position: 'asc' }
        },
        pipeline_steps: {
          include: { member: true },
          orderBy: { position: 'asc' }
        }
      }
    });

    if (!composite) {
      throw new Error(`Composite config missing for model ${this.compositeModelId}`);
    }

    this.strategy = composite.strategy as any;
    this.adapters = composite.members
      .filter(m => m.member.api_provider !== 'composite')
      .map(m => ({
        adapter: getModelAdapter(m.member.api_provider, m.member.api_model_id),
        weight: Math.max(1, m.weight || 1)
      }));

    if (this.adapters.length === 0) {
      throw new Error(`Composite ${this.compositeModelId} has no valid members`);
    }

    if (this.strategy === 'PIPELINE') {
      this.pipeline = composite.pipeline_steps
        .filter(step => step.member.api_provider !== 'composite')
        .map(step => ({
          adapter: getModelAdapter(step.member.api_provider, step.member.api_model_id),
          promptTemplate: step.prompt_template || undefined
        }));

      if (this.pipeline.length < 2) {
        throw new Error(`Composite ${this.compositeModelId} has invalid pipeline configuration`);
      }
    }

    this.initialized = true;
  }

  private pickWeighted() {
    const total = this.adapters.reduce((sum, a) => sum + a.weight, 0);
    let roll = Math.random() * total;
    for (const adapter of this.adapters) {
      roll -= adapter.weight;
      if (roll <= 0) return adapter;
    }
    return this.adapters[this.adapters.length - 1];
  }

  async generateMove(systemPrompt: string, history: GameEvent[]): Promise<string> {
    await this.ensureLoaded();

    if (this.strategy === 'PIPELINE') {
      let input = '';
      for (const step of this.pipeline) {
        const prompt = renderPipelinePrompt(step.promptTemplate, systemPrompt, history, input);
        try {
          const response = await step.adapter.generateMove(prompt, history);
          if (response.startsWith('[Error]')) return response;
          input = response;
        } catch (err: any) {
          return `[Error] ${err.message || 'Pipeline step failed'}`;
        }
      }
      return input || '[Error] Pipeline produced no output';
    }

    if (this.strategy === 'FALLBACK') {
      let lastError = '[Error] Composite fallback failed';
      for (const adapter of this.adapters) {
        try {
          const response = await adapter.adapter.generateMove(systemPrompt, history);
          if (!response.startsWith('[Error]')) return response;
          lastError = response;
        } catch (err: any) {
          lastError = `[Error] ${err.message || 'Fallback adapter failed'}`;
        }
      }
      return lastError;
    }

    const choice = this.strategy === 'RANDOM'
      ? this.pickWeighted()
      : this.adapters[this.pointer++ % this.adapters.length];

    try {
      return await choice.adapter.generateMove(systemPrompt, history);
    } catch (err: any) {
      return `[Error] ${err.message || 'Composite adapter failed'}`;
    }
  }
}

const renderPipelinePrompt = (template: string | undefined, systemPrompt: string, history: GameEvent[], input: string) => {
  const historyText = history.map(e => JSON.stringify(e.payload)).join('\n');
  if (!template || template.trim().length === 0) {
    if (!input) return systemPrompt;
    return `${systemPrompt}\n\nPrevious output:\n${input}\n\nContinue from the above context.`;
  }
  return template
    .replace(/\{\{\s*system\s*\}\}/g, systemPrompt)
    .replace(/\{\{\s*history\s*\}\}/g, historyText)
    .replace(/\{\{\s*input\s*\}\}/g, input || '');
};

export function getModelAdapter(provider: string, modelId: string, apiKey?: string): ModelAdapter {
  // ENV fallback if specific key not passed
  const envKey = (name: string) => process.env[name] || '';

  if (provider === 'mock') {
    return new MockModelAdapter();
  } 
  
  if (provider === 'openai') {
    return new OpenAICompatibleAdapter(apiKey || envKey('OPENAI_API_KEY'), modelId, 'https://api.openai.com/v1');
  }

  if (provider === 'xai') {
    return new OpenAICompatibleAdapter(apiKey || envKey('XAI_API_KEY'), modelId, 'https://api.x.ai/v1');
  }

  if (provider === 'zhipu' || provider === 'z.ai') {
    return new OpenAICompatibleAdapter(apiKey || envKey('ZHIPU_API_KEY') || envKey('Z_AI_API_KEY') || envKey('ZAI_API_KEY'), modelId, 'https://open.bigmodel.cn/api/paas/v4');
  }

  if (provider === 'anthropic') {
      return new AnthropicAdapter(apiKey || envKey('ANTHROPIC_API_KEY'), modelId);
  }

  if (provider === 'google') {
      return new GoogleAdapter(apiKey || envKey('GEMINI_API_KEY'), modelId);
  }

  if (provider === 'composite') {
      return new CompositeAdapter(modelId);
  }

  throw new Error(`Unknown provider: ${provider}`);
}
