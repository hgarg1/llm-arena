import { MatchRepository } from '../repositories/match.repository';
import { startMatch } from './runner/backend';
import { MatchStatus } from '@prisma/client';
import { isRunnerEnabled } from '../config/runtime';
import { prisma } from '../config/db';
import { BUILT_IN_GAME_KEYS } from './game-engine-artifact.service';

export class MatchService {
  private matchRepo = new MatchRepository();

  async createMatch(participants: { modelId: string; role?: string }[], gameType: string = 'iterated-negotiation', options?: any, userId?: string) {
    // 1. Create Match Record in DB
    const seed = Math.floor(Math.random() * 1000000);

    // Pin the runtime the match will run on, so later edits to the game never change a queued match.
    const artifact = await prisma.gameEngineArtifact.findFirst({
      where: {
        status: 'PUBLISHED',
        ...(BUILT_IN_GAME_KEYS.has(gameType) ? { kind: 'NATIVE' as const } : {}),
        game: { key: gameType }
      },
      orderBy: { created_at: 'desc' },
      select: { id: true }
    });
    const engineArtifactId = artifact?.id;

    const match = await this.matchRepo.create({
      game_type: gameType,
      seed: seed,
      options: options ?? undefined,
      engine_artifact_id: engineArtifactId,
      status: MatchStatus.PENDING,
      created_by: userId ? { connect: { id: userId } } : undefined,
      participants: {
        create: participants.map(p => ({
          model: { connect: { id: p.modelId } },
          role: p.role
        }))
      }
    });

    // 2. Hand the match to this deployment's runner (Vercel slices, BullMQ worker, or in-process)
    if (isRunnerEnabled()) {
      try {
        await startMatch(match.id, options);
      } catch (err: any) {
        // Never leave an un-started match sitting in PENDING forever.
        await this.matchRepo.updateStatus(match.id, MatchStatus.FAILED, undefined, `Could not start match: ${err?.message || err}`);
        throw new Error('The match runner is unavailable. Please try again shortly.');
      }
    }

    return match;
  }

  async getMatch(id: string) {
    return this.matchRepo.findById(id);
  }

  async listMatches() {
    return this.matchRepo.findAll();
  }
}
