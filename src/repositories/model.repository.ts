import { prisma } from '../config/db';
import { Model, Prisma } from '@prisma/client';
import { settingsService } from '../services/settings.service';

export class ModelRepository {
  async create(data: Prisma.ModelCreateInput): Promise<Model> {
    const ownerId = (data as any)?.owner?.connect?.id || (data as any)?.owner_id;
    if (ownerId) {
      const settings = await settingsService.getAll();
      const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { tier: true } });
      const tier = user?.tier || 'FREE';
      const limitMap: Record<string, string> = {
        FREE: settings.limit_models_per_user_free,
        PRO: settings.limit_models_per_user_pro,
        ENTERPRISE: settings.limit_models_per_user_enterprise
      };
      const limit = parseInt(limitMap[tier] || '0', 10);
      if (limit > 0) {
        const count = await prisma.model.count({ where: { owner_id: ownerId } });
        if (count >= limit) {
          throw new Error('Model limit reached for this user tier');
        }
      }
    }
    return prisma.model.create({ data });
  }

  async findAll(options?: { search?: string; provider?: string; capability?: string; includeInactive?: boolean }): Promise<Model[]> {
    const where: Prisma.ModelWhereInput = {};

    if (!options?.includeInactive) {
        where.is_active = true;
    }

    if (options?.search) {
        where.name = { contains: options.search, mode: 'insensitive' };
    }

    if (options?.provider) {
        where.api_provider = options.provider;
    }

    if (options?.capability) {
        where.capabilities = { has: options.capability };
    }

    return prisma.model.findMany({
      where,
      include: { owner: { select: { email: true, id: true } } },
      orderBy: { created_at: 'desc' }
    });
  }

  async findById(id: string): Promise<Model | null> {
    return prisma.model.findUnique({
      where: { id },
      include: { owner: { select: { email: true, id: true } } }
    });
  }
}
