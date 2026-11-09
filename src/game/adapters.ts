import { ModelAdapter, GameEvent, MoveRequestOptions, MoveCall, CallMeta, PROVIDER_DEFAULT, UNKNOWN } from './types';

const reported = (value: unknown): string => (typeof value === 'string' && value.trim() ? value : UNKNOWN);
import axios from 'axios';
import { prisma } from '../config/db';

export const REQUEST_TIMEOUT_MS = 90_000;

export class ModelUnavailableError extends Error {
  /** True when the provider answered 429: waiting is the fix, so it must not burn the move's retry budget. */
  public readonly rateLimited: boolean;
  public readonly retryAfterMs?: number;

  constructor(message: string, public readonly cause?: unknown, info: { rateLimited?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ModelUnavailableError';
    this.rateLimited = Boolean(info.rateLimited);
    this.retryAfterMs = info.retryAfterMs;
  }
}

const MAX_RETRY_AFTER_MS = 120_000;

/** `Retry-After` is either seconds or an HTTP date. Capped so a bad header cannot stall a match. */
export const parseRetryAfter = (value: unknown, now = Date.now()): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  const seconds = Number(text);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
};

const eventText = (e: GameEvent) => {
  const text = e.payload?.content;
  return typeof text === 'string' && text.length > 0 ? text : JSON.stringify(e.payload ?? {});
};

type ChatMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Turns the event log into a chat transcript from `role`'s point of view: the player's own earlier
 * moves are `assistant` turns, everything else is `user` context. Consecutive same-role turns are
 * merged (some providers reject them) and the transcript always ends with an explicit prompt to move.
 */
export const buildChatMessages = (history: GameEvent[], role?: string): ChatMessage[] => {
  const messages: ChatMessage[] = [];
  const push = (r: 'user' | 'assistant', content: string) => {
    const last = messages[messages.length - 1];
    if (last && last.role === r) last.content += `\n${content}`;
    else messages.push({ role: r, content });
  };
  for (const e of history) {
    const own = Boolean(role) && e.actor === role;
    push(own ? 'assistant' : 'user', own ? eventText(e) : `[${e.actor}/${e.type}] ${eventText(e)}`);
  }
  push('user', role ? `It is your move (${role}). Reply with your move only.` : 'Make your move.');
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: 'Game log follows.' });
  return messages;
};

const failure = (provider: string, modelId: string, error: any) => {
  const status = error?.response?.status;
  const detail = error?.response?.data?.error?.message || error?.message || 'unknown error';
  return new ModelUnavailableError(`${provider} ${modelId} failed${status ? ` (${status})` : ''}: ${detail}`, error, {
    rateLimited: status === 429,
    retryAfterMs: parseRetryAfter(error?.response?.headers?.['retry-after'])
  });
};

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

  async generateMoveWithMeta(systemPrompt: string, history: GameEvent[]): Promise<MoveCall> {
    return { text: await this.generateMove(systemPrompt, history), meta: { adapter: 'mock', model_reported: 'mock', sampling: { temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN } } };
  }
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
      private apiKey: string, 
      private modelId: string, 
      private baseUrl: string = 'https://api.openai.com/v1',
      private headers: Record<string, string> = {}
  ) {}

  async generateMove(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<string> {
    return (await this.generateMoveWithMeta(systemPrompt, history, role, options)).text;
  }

  async generateMoveWithMeta(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<MoveCall> {
    if (!this.apiKey) throw new ModelUnavailableError(`No API key configured for ${this.baseUrl}`);
    try {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(e => {
                const own = Boolean(role) && e.actor === role;
                const msgRole = own ? 'assistant' : 'user';
                const text = own ? eventText(e) : `[${e.actor}/${e.type}] ${eventText(e)}`;
                if (!own && e.payload?.images && e.payload.images.length > 0) {
                    const content: any[] = [{ type: 'text', text }];
                    e.payload.images.forEach((url: string) => {
                        content.push({ type: 'image_url', image_url: { url: url.startsWith('http') ? url : `data:image/jpeg;base64,${url}` } });
                    });
                    return { role: msgRole, content };
                }
                return { role: msgRole, content: text };
            }),
            { role: 'user', content: role ? `It is your move (${role}). Reply with your move only.` : 'Make your move.' }
        ];

        // Reasoning models reject a custom temperature.
        const fixedTemperature = /^(o\d|gpt-5)/i.test(this.modelId);
        const res = await axios.post(`${this.baseUrl}/chat/completions`, {
            model: this.modelId,
            messages,
            ...(fixedTemperature ? {} : { temperature: 0 })
        }, {
            timeout: options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...this.headers
            }
        });

        const text = res.data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('Empty completion');
        return {
          text,
          meta: { adapter: 'openai-compatible', model_reported: reported(res.data?.model), sampling: { temperature: fixedTemperature ? PROVIDER_DEFAULT : 0, max_tokens: PROVIDER_DEFAULT, top_p: PROVIDER_DEFAULT } }
        };
    } catch (error: any) {
        if (error instanceof ModelUnavailableError) throw error;
        throw failure('openai-compatible', this.modelId, error);
    }
  }
}

export class AnthropicAdapter implements ModelAdapter {
    constructor(private apiKey: string, private modelId: string) {}
  
    async generateMove(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<string> {
      return (await this.generateMoveWithMeta(systemPrompt, history, role, options)).text;
    }

    async generateMoveWithMeta(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<MoveCall> {
      if (!this.apiKey) throw new ModelUnavailableError('No API key configured for Anthropic');
      try {
          const res = await axios.post('https://api.anthropic.com/v1/messages', {
              model: this.modelId,
              system: systemPrompt,
              messages: buildChatMessages(history, role),
              max_tokens: 1024,
              temperature: 0
          }, {
              timeout: options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
              headers: {
                  'x-api-key': this.apiKey,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json'
              }
          });

          const text = (res.data?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          if (!text) throw new Error('Empty completion');
          return { text, meta: { adapter: 'anthropic', model_reported: reported(res.data?.model), sampling: { temperature: 0, max_tokens: 1024, top_p: PROVIDER_DEFAULT } } };
      } catch (error: any) {
          if (error instanceof ModelUnavailableError) throw error;
          throw failure('anthropic', this.modelId, error);
      }
    }
}

export class GoogleAdapter implements ModelAdapter {
    constructor(private apiKey: string, private modelId: string) {}
  
    async generateMove(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<string> {
      return (await this.generateMoveWithMeta(systemPrompt, history, role, options)).text;
    }

    async generateMoveWithMeta(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<MoveCall> {
      if (!this.apiKey) throw new ModelUnavailableError('No API key configured for Google');
      try {
          const contents = buildChatMessages(history, role).map(m => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }]
          }));

          const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent`, {
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents,
              generationConfig: { temperature: 0 }
          }, {
              timeout: options?.timeoutMs ?? REQUEST_TIMEOUT_MS,
              headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }
          });

          const text = res.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
          if (!text) throw new Error('Empty completion');
          return { text, meta: { adapter: 'google', model_reported: reported(res.data?.modelVersion), sampling: { temperature: 0, max_tokens: PROVIDER_DEFAULT, top_p: PROVIDER_DEFAULT } } };
      } catch (error: any) {
          if (error instanceof ModelUnavailableError) throw error;
          throw failure('google', this.modelId, error);
      }
    }
}

export class CompositeAdapter implements ModelAdapter {
  private initialized = false;
  private adapters: { adapter: ModelAdapter; weight: number; provider: string; modelId: string }[] = [];
  private pipeline: { adapter: ModelAdapter; promptTemplate?: string; provider: string; modelId: string }[] = [];
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
        weight: Math.max(1, m.weight || 1),
        provider: m.member.api_provider,
        modelId: m.member.api_model_id
      }));

    if (this.adapters.length === 0) {
      throw new Error(`Composite ${this.compositeModelId} has no valid members`);
    }

    if (this.strategy === 'PIPELINE') {
      this.pipeline = composite.pipeline_steps
        .filter(step => step.member.api_provider !== 'composite')
        .map(step => ({
          adapter: getModelAdapter(step.member.api_provider, step.member.api_model_id),
          promptTemplate: step.prompt_template || undefined,
          provider: step.member.api_provider,
          modelId: step.member.api_model_id
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

  async generateMove(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<string> {
    return (await this.generateMoveWithMeta(systemPrompt, history, role, options)).text;
  }

  /** Calls a member and keeps what it reports; a member that reports nothing is recorded as UNKNOWN, never as blank. */
  private async call(member: { adapter: ModelAdapter }, prompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<MoveCall> {
    if (member.adapter.generateMoveWithMeta) return member.adapter.generateMoveWithMeta(prompt, history, role, options);
    return { text: await member.adapter.generateMove(prompt, history, role, options), meta: { adapter: UNKNOWN, model_reported: UNKNOWN, sampling: { temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN } } };
  }

  async generateMoveWithMeta(systemPrompt: string, history: GameEvent[], role?: string, options?: MoveRequestOptions): Promise<MoveCall> {
    await this.ensureLoaded();

    if (this.strategy === 'PIPELINE') {
      let input = '';
      let last: MoveCall | null = null;
      const steps: NonNullable<CallMeta['steps']> = [];
      for (const step of this.pipeline) {
        const prompt = renderPipelinePrompt(step.promptTemplate, systemPrompt, history, input);
        last = await this.call(step, prompt, history, role, options);
        input = last.text;
        steps.push({ provider: step.provider, requested: step.modelId, reported: last.meta.model_reported });
      }
      if (!input || !last) throw new ModelUnavailableError('Pipeline produced no output');
      const final = this.pipeline[this.pipeline.length - 1];
      return { text: input, meta: { ...last.meta, member: { provider: final.provider, requested: final.modelId }, steps } };
    }

    if (this.strategy === 'FALLBACK') {
      let lastError: unknown = new ModelUnavailableError('Composite fallback has no members');
      for (const member of this.adapters) {
        try {
          const result = await this.call(member, systemPrompt, history, role, options);
          return { text: result.text, meta: { ...result.meta, member: { provider: member.provider, requested: member.modelId } } };
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    }

    const choice = this.strategy === 'RANDOM'
      ? this.pickWeighted()
      : this.adapters[this.pointer++ % this.adapters.length];

    const result = await this.call(choice, systemPrompt, history, role, options);
    return { text: result.text, meta: { ...result.meta, member: { provider: choice.provider, requested: choice.modelId } } };
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
