import { prisma } from './config/db';

const defaults = [
  { key: 'free', name: 'Free', level: 1, description_short: 'Core access for evaluation basics.', description_long: 'Access to standard evaluations and public models.' },
  { key: 'pro', name: 'Pro', level: 2, description_short: 'Higher throughput for teams.', description_long: 'Expanded limits, faster queues, and advanced configuration.' },
  { key: 'enterprise', name: 'Enterprise', level: 3, description_short: 'Enterprise-grade controls.', description_long: 'Full control, compliance features, and dedicated support.' }
];

const ensureDefaultPlansOld = async () => {
  for (const plan of defaults) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { key: plan.key } });
    if (!existing) {
      await prisma.subscriptionPlan.create({
        data: {
          key: plan.key,
          name: plan.name,
          level: plan.level,
          description_short: plan.description_short,
          description_long: plan.description_long,
          price_cents: plan.key === 'pro' ? 4900 : null
        }
      });
    }
  }
};

const ensureDefaultPlansNew = async () => {
  const existingPlans = await prisma.subscriptionPlan.findMany({
    where: { key: { in: defaults.map((p: any) => p.key) } },
    select: { key: true }
  });
  const existingKeys = new Set(existingPlans.map((p: any) => p.key));

  const plansToCreate = defaults.filter((p: any) => !existingKeys.has(p.key));

  if (plansToCreate.length > 0) {
    await prisma.subscriptionPlan.createMany({
      data: plansToCreate.map((plan: any) => ({
        key: plan.key,
        name: plan.name,
        level: plan.level,
        description_short: plan.description_short,
        description_long: plan.description_long,
        price_cents: plan.key === 'pro' ? 4900 : null
      }))
    });
  }
};

async function run() {
  console.log("Warming up...");
  await ensureDefaultPlansOld();

  const ITERATIONS = 100;

  console.log(`Running Old Method ${ITERATIONS} times...`);
  const startOld = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await ensureDefaultPlansOld();
  }
  const endOld = Date.now();

  console.log(`Running New Method ${ITERATIONS} times...`);
  const startNew = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await ensureDefaultPlansNew();
  }
  const endNew = Date.now();

  console.log(`Old: ${endOld - startOld}ms`);
  console.log(`New: ${endNew - startNew}ms`);
  console.log(`Improvement: ${((endOld - startOld) - (endNew - startNew)) / (endOld - startOld) * 100}%`);

  process.exit(0);
}

run().catch(console.error);
