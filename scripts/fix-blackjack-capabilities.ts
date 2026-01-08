import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const models = await prisma.model.findMany();
  for (const model of models) {
    if (model.capabilities.includes('texas_holdem') && !model.capabilities.includes('blackjack')) {
      await prisma.model.update({
        where: { id: model.id },
        data: { capabilities: { push: 'blackjack' } }
      });
      console.log(`Updated ${model.name} to include blackjack`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
