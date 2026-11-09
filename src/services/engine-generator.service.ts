import { GameDefinition, GameSetting, GameUISchema } from '@prisma/client';
import dotenv from 'dotenv';
import { transpileGameEngineArtifact } from './game-engine-artifact.service';

dotenv.config();

type EngineBundle = {
  spec: Record<string, any>;
  code: string;
  tests: string;
  notes: string;
  uiSchema: { create_form_layout: any[]; summary_template?: any; labels?: any } | null;
  generationProvider: 'openai' | 'gemini' | 'fallback';
  usedFallback: boolean;
  generationError: string | null;
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
    getActiveRole: 'getActiveRole(history: GameEvent[]): string | null  // role that moves next; "system" if the engine advances itself',
    initialize: 'initialize(seed: number, options?: Record<string, any>): GameEvent[]',
    processMove: 'processMove(history: GameEvent[], move: PlayerMove): { events: GameEvent[]; result: GameResult | null }',
    getSystemPrompt: 'getSystemPrompt(role: string): string',
    getRandomMove: 'getRandomMove(history: GameEvent[], role: string): PlayerMove'
  }
});

export const buildUiSchemaFromSettings = (settings: GameSetting[]) => ({
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

const generateFallback = (
  game: GameDefinition & { settings: GameSetting[]; ui_schema: GameUISchema | null },
  reason = 'Fallback stub engine generated. Replace with real logic before production.'
): EngineBundle => {
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

  getRandomMove(history: GameEvent[], role: string): PlayerMove {
    return { actor: role, content: 'PASS' };
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

  const notes = reason;

  return {
    spec: buildSpec(game),
    code,
    tests,
    notes,
    uiSchema: buildUiSchemaFromSettings(game.settings),
    generationProvider: 'fallback',
    usedFallback: true,
    generationError: reason
  };
};

const parseJsonFromLLM = (text: string) => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through to brace matching
    }
  }
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
  const spec = buildSpec(game);
  const fallback = generateFallback(game);
  const basePrompt = `
You are generating a TypeScript game engine. Return ONLY a JSON object with keys: spec, code, tests, notes, ui_schema.
Constraints for "code":
- A single module: \`import { GameEngine, GameEvent, GameResult, PlayerMove } from '../types';\` (type imports only; no other imports, no require, no fs/process/network).
- \`export default class ${toPascal(game.key)}Game implements GameEngine\`, with \`gameType = '${game.key}'\`.
- Implement initialize, processMove, getSystemPrompt, getRandomMove, and getActiveRole (return the role that must move next, or null for round-robin).
- Every GameEvent needs a numeric turn, string actor, string type and an object payload. Turn numbers must never decrease.
- Deterministic: use a seeded RNG derived from the seed passed to initialize. Never use Math.random or Date.
- The game MUST terminate (cap the number of turns) and the final processMove must return result { isFinished: true, scores } where scores has a numeric entry for each role (${JSON.stringify(game.roles.length ? game.roles : ['player1', 'player2'])}).
- getRandomMove must always return a legal move so the engine can be validated by random play.
- Hidden information must not appear in public events; if there is any, also implement getObservation(history, role).
- Use the provided spec for settings and roles. ui_schema.create_form_layout must only reference existing setting keys.
Spec:
${JSON.stringify(spec, null, 2)}
`;

  const fetchFn = getFetch();
  if (opts.forceFallback) {
    return generateFallback(game, 'Fallback stub engine generated. Forced fallback mode is enabled.');
  }
  if (!fetchFn) {
    return generateFallback(game, 'Fallback stub engine generated because fetch is unavailable in the current runtime.');
  }

  const bundleFromProviderJson = (
    provider: 'openai' | 'gemini',
    json: any
  ): EngineBundle => {
    const code = typeof json?.code === 'string' && json.code.trim().length > 0
      ? json.code
      : fallback.code;
    const usedFallback = code === fallback.code;
    const generationError = usedFallback
      ? `${provider} response did not include engine code, so a fallback stub was generated.`
      : null;

    return {
      spec: json?.spec || spec,
      code,
      tests: typeof json?.tests === 'string' && json.tests.trim().length > 0 ? json.tests : fallback.tests,
      notes: [
        typeof json?.notes === 'string' && json.notes.trim().length > 0 ? json.notes : 'LLM generated.',
        usedFallback ? generationError : null
      ].filter(Boolean).join('\n\n'),
      uiSchema: json?.ui_schema || fallback.uiSchema,
      generationProvider: usedFallback ? 'fallback' : provider,
      usedFallback,
      generationError
    };
  };

  const callOpenAI = async (prompt: string) => {
    const response = await fetchFn('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_ENGINE_MODEL || 'gpt-4o-mini',
        input: prompt
      })
    });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    const data = await response.json();
    const text = data?.output?.[0]?.content?.[0]?.text || data?.output_text || '';
    const json = parseJsonFromLLM(text);
    return bundleFromProviderJson('openai', json);
  };

  const callGemini = async (prompt: string) => {
    if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
    const response = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_ENGINE_MODEL || 'gemini-3-pro-preview')}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 }
        })
      }
    );
    if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    const json = parseJsonFromLLM(text);
    return bundleFromProviderJson('gemini', json);
  };

  const preferredProvider: 'openai' | 'gemini' =
    process.env.ENGINE_PROVIDER === 'openai' ? 'openai' : 'gemini';
  const providerOrder = [
    preferredProvider,
    preferredProvider === 'openai' ? 'gemini' : 'openai'
  ].filter((provider, index, arr) =>
    arr.indexOf(provider) === index &&
    (
      (provider === 'openai' && Boolean(process.env.OPENAI_API_KEY)) ||
      (provider === 'gemini' && Boolean(process.env.GEMINI_API_KEY))
    )
  ) as Array<'openai' | 'gemini'>;

  if (providerOrder.length === 0) {
    return generateFallback(game, 'Fallback stub engine generated because no engine provider credentials are configured.');
  }

  const failures: string[] = [];
  for (const provider of providerOrder) {
    try {
      const call = provider === 'openai' ? callOpenAI : callGemini;
      let bundle = await call(basePrompt);
      // Give the model two chances to fix compile errors before giving up on this provider.
      for (let repair = 0; repair < 2 && !bundle.usedFallback; repair++) {
        const compiled = transpileGameEngineArtifact(game.key, bundle.code);
        if (compiled.ok) break;
        bundle = await call(
          `${basePrompt}\nYour previous code failed to compile with these errors:\n${compiled.diagnostics.join('\n')}\n` +
          `Previous code:\n${bundle.code}\nReturn the corrected full JSON object.`
        );
      }
      return bundle;
    } catch (err: any) {
      failures.push(`${provider}: ${String(err?.message || err)}`);
    }
  }

  return generateFallback(
    game,
    `Fallback stub engine generated after provider failures. ${failures.join(' | ')}`
  );
};
