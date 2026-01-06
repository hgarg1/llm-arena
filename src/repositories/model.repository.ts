import { prisma } from '../config/db';
import { Model, Prisma } from '@prisma/client';

export class ModelRepository {
  async create(data: Prisma.ModelCreateInput): Promise<Model> {
    return prisma.model.create({ data });
  }

  async findAll(): Promise<Model[]> {
    return prisma.model.findMany({
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
