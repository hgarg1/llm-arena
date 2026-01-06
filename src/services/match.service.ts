import { MatchRepository } from '../repositories/match.repository';
import { matchQueue } from './queue';
import { MatchStatus } from '@prisma/client';

export class MatchService {
  private matchRepo = new MatchRepository();

  async createMatch(modelIds: string[], gameType: string = 'iterated-negotiation') {
    // 1. Create Match Record in DB
    const seed = Math.floor(Math.random() * 1000000);
    
    const match = await this.matchRepo.create({
      game_type: gameType,
      seed: seed,
      status: MatchStatus.PENDING,
      participants: {
        create: modelIds.map(id => ({
          model: { connect: { id } }
        }))
      }
    });

    // 2. Add to Queue
    await matchQueue.add('run-match', { matchId: match.id });

    return match;
  }

  async getMatch(id: string) {
    return this.matchRepo.findById(id);
  }

  async listMatches() {
    return this.matchRepo.findAll();
  }
}
