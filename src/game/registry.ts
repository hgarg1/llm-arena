import { IteratedNegotiationGame } from './negotiation';
import { ChessGame } from './chess';
import { ChutesLaddersGame } from './chutes_ladders';
import { TexasHoldemGame } from './poker';
import { BlackjackGame } from './blackjack';
import { GameEngine } from './types';
import { prisma } from '../config/db';
import { instantiateGameEngineArtifact } from '../services/game-engine-artifact.service';

export class GameEngineNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameEngineNotFoundError';
  }
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const builtIns: Record<string, () => GameEngine> = {
  'iterated-negotiation': () => new IteratedNegotiationGame(),
  chess: () => new ChessGame(),
  chutes_and_ladders: () => new ChutesLaddersGame(),
  texas_holdem: () => new TexasHoldemGame(),
  blackjack: () => new BlackjackGame()
};

/**
 * Resolves the engine for a game. Every game is a `GameEngineArtifact` row: NATIVE rows point at a
 * built-in class, SANDBOXED rows hold generated code that runs in an isolated worker. Built-ins still
 * resolve without a database round trip when no artifact is pinned.
 */
export const resolveGameEngine = async (
  gameType: string,
  artifactId?: string | null
): Promise<{ engine: GameEngine; artifactId: string | null }> => {
  const builtIn = builtIns[gameType];
  if (builtIn && !artifactId) return { engine: builtIn(), artifactId: null };

  if (!KEY_PATTERN.test(gameType) && !builtIn) {
    throw new GameEngineNotFoundError(`Game engine "${gameType}" is invalid or unavailable.`);
  }

  const select = { id: true, kind: true, native_key: true, code_ts: true } as const;
  const artifact = artifactId
    ? await prisma.gameEngineArtifact.findFirst({ where: { id: artifactId, game: { key: gameType } }, select })
    : await prisma.gameEngineArtifact.findFirst({
        where: { status: 'PUBLISHED', game: { key: gameType } },
        orderBy: { created_at: 'desc' },
        select
      });

  if (artifact?.kind === 'NATIVE') {
    const factory = builtIns[artifact.native_key || gameType];
    if (!factory) throw new GameEngineNotFoundError(`Native engine "${artifact.native_key}" is not available in this build.`);
    return { engine: factory(), artifactId: artifact.id };
  }
  if (!artifact) {
    // A pinned artifact that no longer exists must not stop a built-in game from running.
    if (builtIn) return { engine: builtIn(), artifactId: null };
    throw new GameEngineNotFoundError(`Published runtime not found for game "${gameType}".`);
  }
  return { engine: instantiateGameEngineArtifact(gameType, artifact.code_ts), artifactId: artifact.id };
};

export const getGameEngine = async (gameType: string, artifactId?: string | null): Promise<GameEngine> =>
  (await resolveGameEngine(gameType, artifactId)).engine;
