import { GameDefinition, GameSetting, GameUISchema } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

type EngineBundle = {
  spec: Record<string, any>;
  code: string;
  tests: string;
  notes: string;
  uiSchema: { create_form_layout: any[]; summary_template?: any; labels?: any } | null;
};

const toPascal = (input: string) =>
  input
    .replace(/(^\w|[_-]\w)/g, match => match.replace(/[_-]/, '').toUpperCase())
    .replace(/[^A-Za-z0-9]/g, '');

const buildSpec = (game: GameDefinition & { settings: GameSetting[]; ui_schema: GameUISchema | null }) => ({
  game_key: game.key,
  name: game.name,
  roles: game.roles,
  max_players: game.max_players,
  settings: game.settings.map(s => ({
    key: s.key,
    type: s.type,
    default: s.default_value,
    min: s.min_value,
    max: s.max_value,
    tier: s.tier_required
  })),
  ui_schema: game.ui_schema || null,
  engine_contract: {
    initialize: 'initialize(seed: number, options?: Record<string, any>): GameEvent[]',
    processMove: 'processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[]; result: GameResult | null }',
    getSystemPrompt: 'getSystemPrompt(role: string): string'
  }
});

const buildUiSchemaFromSettings = (settings: GameSetting[]) => ({
  create_form_layout: settings.map(setting => ({
    key: setting.key,
    label: setting.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    type:
      setting.type === 'BOOLEAN' ? 'toggle' :
      setting.type === 'ENUM' ? 'select' :
      setting.type === 'INT' || setting.type === 'FLOAT' ? 'number' :
      'text',
    tier: setting.tier_required
  }))
});

const generateFallback = (game: GameDefinition & { settings: GameSetting[]; ui_schema: GameUISchema | null }): EngineBundle => {
  const className = `${toPascal(game.key)}Game`;
  const roles = game.roles.length > 0 ? game.roles : ['player1', 'player2'];
  const settingsDefaults = game.settings.reduce<Record<string, any>>((acc, s) => {
    acc[s.key] = s.default_value;
    return acc;
  }, {});
  const code = `import { GameEngine, GameEvent, GameResult, PlayerMove } from '../types';

export default class ${className} implements GameEngine {
  gameType = '${game.key}';
  private turnCount = 0;
  private maxTurns = 10;
  private settings: Record<string, any> = ${JSON.stringify(settingsDefaults, null, 2)};
  private roles = ${JSON.stringify(roles, null, 2)};

  initialize(seed: number, options?: Record<string, any>): GameEvent[] {
    this.turnCount = 0;
    if (options?.maxTurns) this.maxTurns = Math.max(1, parseInt(String(options.maxTurns), 10));
    return [{
      turn: 0,
      actor: 'system',
      type: 'MATCH_START',
      payload: {
        game_key: this.gameType,
        seed,
        ruleset_version: '0.1.0',
        settings: this.settings,
        roles: this.roles
      }
    }];
  }

  getSystemPrompt(role: string): string {
    return \`You are playing ${game.name}. Role: \${role}. Provide the next action.\`;
  }

  processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[]; result: GameResult | null } {
    const turnIndex = history[history.length - 1].turn + 1;
    this.turnCount += 1;
    const events: GameEvent[] = [{
      turn: turnIndex,
      actor: move.actor,
      type: 'PLAYER_ACTION',
      payload: { raw: move.content }
    }];

    if (this.turnCount >= this.maxTurns) {
      events.push({
        turn: turnIndex + 1,
        actor: 'system',
        type: 'RESULT',
        payload: { outcome: 'stub', reason: 'auto_generated_engine', total_turns: this.turnCount }
      });
      return { events, result: { isFinished: true, scores: {}, winnerId: undefined } };
    }

    return { events, result: null };
  }
}
`;

  const tests = `import ${className} from './${game.key}';

describe('${className}', () => {
  it('initializes and completes after max turns', () => {
    const engine = new ${className}();
    const events = engine.initialize(1, { maxTurns: 2 });
    expect(events[0].type).toBe('MATCH_START');
  });
});
`;

  const notes = 'Fallback stub engine generated. Replace with real logic before production.';

  return {
    spec: buildSpec(game),
    code,
    tests,
    notes,
    uiSchema: buildUiSchemaFromSettings(game.settings)
  };
};

const parseJsonFromLLM = (text: string) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('LLM response missing JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
};

type FetchLike = (input: string, init?: any) => Promise<any>;

const getFetch = (): FetchLike | null => {
  const fetchFn = (globalThis as any).fetch as FetchLike | undefined;
  return fetchFn || null;
};

export const generateEngineBundle = async (
  game: GameDefinition & { settings: GameSetting[]; ui_schema: GameUISchema | null },
  opts: { forceFallback?: boolean } = {}
): Promise<EngineBundle> => {
  if (opts.forceFallback || !process.env.OPENAI_API_KEY) {
    return generateFallback(game);
  }

  const spec = buildSpec(game);
  const prompt = `
You are generating a TypeScript game engine. Return JSON with keys: spec, code, tests, notes, ui_schema.
Constraints:
- Implement GameEngine from src/game/types.
- Export default class named ${toPascal(game.key)}Game.
- Keep deterministic behavior; use seeded RNG if needed.
- Use the provided spec for settings and roles.
- ui_schema.create_form_layout must reference existing setting keys.
Spec:
${JSON.stringify(spec, null, 2)}
`;

  const fetchFn = getFetch();
  if (!fetchFn) return generateFallback(game);

  const callOpenAI = async () => {
    const response = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ENGINE_MODEL || 'gpt-4o-mini',
        input: prompt,
        temperature: 0.2
      })
    });
    if (!response.ok) throw new Error('OpenAI request failed');
    const data = await response.json();
    const text = data?.output?.[0]?.content?.[0]?.text || data?.output_text || '';
    const json = parseJsonFromLLM(text);
    return {
      spec: json.spec || spec,
      code: json.code || generateFallback(game).code,
      tests: json.tests || generateFallback(game).tests,
      notes: json.notes || 'LLM generated.',
      uiSchema: json.ui_schema || generateFallback(game).uiSchema
    };
  };

  const callGemini = async () => {
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
    const response = await fetchFn(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 }
        })
      }
    );
    if (!response.ok) throw new Error('Gemini request failed');
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    const json = parseJsonFromLLM(text);
    return {
      spec: json.spec || spec,
      code: json.code || generateFallback(game).code,
      tests: json.tests || generateFallback(game).tests,
      notes: json.notes || 'LLM generated.',
      uiSchema: json.ui_schema || generateFallback(game).uiSchema
    };
  };

  const provider = process.env.ENGINE_PROVIDER || 'gemini';
  try {
    if (provider === 'openai') {
      return await callOpenAI();
    }
    return await callGemini();
  } catch (err) {
    try {
      return provider === 'openai' ? await callGemini() : await callOpenAI();
    } catch (innerErr) {
      return generateFallback(game);
    }
  }
};
