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

  async findAll(options?: { search?: string; gameType?: string; status?: MatchStatus; page?: number; limit?: number }) {
    const where: Prisma.MatchWhereInput = {};
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    if (options?.gameType) {
        where.game_type = options.gameType;
    }

    if (options?.status) {
        where.status = options.status;
    }

    if (options?.search) {
        // Search by Match ID or Participant Model Name
        where.OR = [
            { id: { contains: options.search, mode: 'insensitive' } },
            { participants: { some: { model: { name: { contains: options.search, mode: 'insensitive' } } } } }
        ];
    }

    const [matches, total] = await Promise.all([
        prisma.match.findMany({
            where,
            include: {
                participants: { include: { model: true } },
                tournament: true
            },
            orderBy: { created_at: 'desc' },
            skip,
            take: limit
        }),
        prisma.match.count({ where })
    ]);

    return { matches, total, page, limit, totalPages: Math.ceil(total / limit) };
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

  async addEvents(data: Prisma.MatchEventCreateManyInput[]) {
    return prisma.matchEvent.createMany({ data });
  }
}
