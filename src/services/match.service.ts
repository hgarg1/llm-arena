import { MatchRepository } from '../repositories/match.repository';
import { matchQueue } from './queue';
import { MatchStatus } from '@prisma/client';
import { settingsService } from './settings.service';

export class MatchService {
  private matchRepo = new MatchRepository();

  async createMatch(participants: { modelId: string; role?: string }[], gameType: string = 'iterated-negotiation', options?: any, userId?: string) {
    // 1. Create Match Record in DB
    const seed = Math.floor(Math.random() * 1000000);
    
    const match = await this.matchRepo.create({
      game_type: gameType,
      seed: seed,
      status: MatchStatus.PENDING,
      created_by: userId ? { connect: { id: userId } } : undefined,
      participants: {
        create: participants.map(p => ({
          model: { connect: { id: p.modelId } },
          role: p.role
        }))
      }
    });

    // 2. Add to Queue with Options
    const settings = await settingsService.getAll();
    const attempts = parseInt(settings.queue_retry_attempts || '3', 10);
    const backoffMs = parseInt(settings.queue_retry_backoff_ms || '5000', 10);
    await matchQueue.add(
      'run-match',
      { matchId: match.id, options },
      {
        attempts: Math.max(1, attempts),
        backoff: { type: 'fixed', delay: Math.max(0, backoffMs) }
      }
    );

    return match;
  }

  async getMatch(id: string) {
    return this.matchRepo.findById(id);
  }

  async listMatches() {
    return this.matchRepo.findAll();
  }
}
