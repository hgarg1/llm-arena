import { StripePriceStatus } from '@prisma/client';

async function runBenchmark() {
  const numPrices = 10000;
  const mockStripePrices = [];

  for (let i = 0; i < numPrices; i++) {
    const stripeId = `price_test_${Date.now()}_${i}`;
    mockStripePrices.push({
      id: stripeId,
      active: true,
      nickname: 'Test Price ' + i,
      currency: 'usd',
      unit_amount: 1000,
      recurring: { interval: 'month', interval_count: 1 },
      metadata: {}
    });
  }

  // Simulate Prisma
  const simulatedDB = new Map();
  for (let i = 0; i < numPrices; i++) {
    if (i % 2 === 0) {
      simulatedDB.set(mockStripePrices[i].id, {
        plan_id: '123',
        stripe_price_id: mockStripePrices[i].id,
        stripe_product_id: 'prod_123',
        status: StripePriceStatus.ACTIVE,
        is_default: false,
        mode: 'TEST',
        created_by: 'system'
      });
    }
  }

  // Baseline: N+1 approach (simulated)
  // Even just the overhead of making N async calls is huge in Node, so we simulate an async delay
  console.log("Starting N+1 benchmark (simulated database latency)...");
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const simNetworkLatency = 1; // 1ms per query

  const startN1 = Date.now();
  for (let i = 0; i < 50; i++) {
    const price = mockStripePrices[i];
    await delay(simNetworkLatency); // simulate query
    const existing = simulatedDB.get(price.id);
    void (existing?.status === StripePriceStatus.LEGACY ? StripePriceStatus.LEGACY : StripePriceStatus.ACTIVE);
  }
  const endN1 = Date.now();
  // extrapolate to full dataset
  console.log(`N+1 approach took: ${(endN1 - startN1) * (numPrices / 50)}ms (extrapolated)`);

  // Optimized approach
  console.log("Starting optimized benchmark (simulated database latency)...");
  const startOpt = Date.now();
  const priceIds = mockStripePrices.map(p => p.id);
  // simulate one large query taking slightly longer than one small query
  await delay(simNetworkLatency * 5);
  const existingMap = new Map();
  for (const id of priceIds) {
    if (simulatedDB.has(id)) {
      existingMap.set(id, simulatedDB.get(id));
    }
  }

  for (const price of mockStripePrices) {
    const existing = existingMap.get(price.id);
    void (existing?.status === StripePriceStatus.LEGACY ? StripePriceStatus.LEGACY : StripePriceStatus.ACTIVE);
  }
  const endOpt = Date.now();
  console.log(`Optimized approach took: ${endOpt - startOpt}ms`);
}

runBenchmark().catch(console.error);
