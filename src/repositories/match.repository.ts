import { prisma } from '../config/db';
import { Match, MatchEvent, MatchStatus, Prisma } from '@prisma/client';

export class MatchRepository {
  async create(data: Prisma.MatchCreateInput): Promise<Match> {
    return prisma.match.create({ data });
  }

  async findById(id: string) {
    return prisma.match.findUnique({
      where: { id },
      include: {
        participants: { include: { model: true } },
        events: { orderBy: { turn_index: 'asc' } },
        tournament: true
      }
    });
  }

  async findAll(filter?: Prisma.MatchWhereInput) {
    return prisma.match.findMany({
      where: filter,
      include: {
        participants: { include: { model: true } },
        tournament: true
      },
      orderBy: { created_at: 'desc' },
      take: 50
    });
  }

  async updateStatus(id: string, status: MatchStatus, finishedAt?: Date) {
    return prisma.match.update({
      where: { id },
      data: { status, finished_at: finishedAt }
    });
  }

  async addEvent(data: Prisma.MatchEventCreateInput) {
    return prisma.matchEvent.create({ data });
  }
}
