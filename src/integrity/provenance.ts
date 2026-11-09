/**
 * Per-move provenance (docs/INTEGRITY_SPEC.md, member `provenance`): where a move came from and, for a model, which prompt,
 * model and sampling settings produced it. Stored with each move (MatchMove.provenance) and committed to by the signed
 * manifest through a digest of all the moves (see the moves chain in verify.ts).
 *
 * Every field holds a real value or says why it does not: `unknown` (the adapter cannot tell), `provider-default` (we did not
 * send it, so the provider's own setting applied), or `null` for a part that does not apply to this kind of move. A blank is
 * never a valid value.
 */
import { createHash } from 'crypto';
import { CallMeta, Marker, UNKNOWN } from '../game/types';

export type MoveSource = 'model' | 'random' | 'engine';

export interface PromptIdentity {
  /** Stable name of the template: `<game key>/<role>`. */
  id: string;
  /** The ruleset version the engine declared for this match, or `unknown`. */
  version: string;
  /** SHA-256 of the exact system prompt text sent for this move. */
  sha256: string;
}

export interface MoveProvenance {
  v: 1;
  source: MoveSource;
  /** null when no prompt was involved (random and engine moves). */
  prompt: PromptIdentity | null;
  /** null for engine moves. For a composite model this is the member that answered, with `via` naming the composite. */
  model: { provider: string; requested: string; reported: string; via?: string; steps?: NonNullable<CallMeta['steps']> } | null;
  /** null when sampling does not apply (random and engine moves). */
  sampling: { temperature: number | Marker; max_tokens: number | Marker; top_p: number | Marker } | null;
  /** The adapter that made the call (`openai-compatible`, `anthropic`, `google`...), `unknown` if it did not say, null if none. */
  adapter: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const promptIdentity = (gameType: string, role: string, systemPrompt: string, rulesetVersion?: unknown): PromptIdentity => ({
  id: `${gameType}/${role}`,
  version: typeof rulesetVersion === 'string' && rulesetVersion.trim() ? rulesetVersion : UNKNOWN,
  sha256: sha256(systemPrompt)
});

/** A move produced by a model call. `meta` is null when the adapter reports nothing: every field is then `unknown`. */
export const modelProvenance = (input: { provider: string; requested: string; prompt: PromptIdentity; meta: CallMeta | null }): MoveProvenance => {
  const { meta } = input;
  const member = meta?.member;
  return {
    v: 1,
    source: 'model',
    prompt: input.prompt,
    model: {
      provider: member?.provider ?? input.provider,
      requested: member?.requested ?? input.requested,
      reported: meta?.model_reported ?? UNKNOWN,
      ...(member ? { via: input.requested } : {}),
      ...(meta?.steps ? { steps: meta.steps } : {})
    },
    sampling: meta?.sampling ?? { temperature: UNKNOWN, max_tokens: UNKNOWN, top_p: UNKNOWN },
    adapter: meta?.adapter ?? UNKNOWN
  };
};

/** The mock model: a seeded random legal move chosen by the engine, with no prompt and no sampling. */
export const randomProvenance = (provider: string, requested: string): MoveProvenance => ({
  v: 1, source: 'random', prompt: null, model: { provider, requested, reported: provider }, sampling: null, adapter: 'seeded-random'
});

/** A move the engine made itself (a resolve step, or a move that needs no decision). */
export const engineProvenance = (): MoveProvenance => ({ v: 1, source: 'engine', prompt: null, model: null, sampling: null, adapter: null });
