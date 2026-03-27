import { PrismaClient } from '@prisma/client';

describe('ModelSyncService Performance', () => {
    let service: any;
    let mockPrisma: any;
    let mockAxios: any;

    // Simulate latency
    const LATENCY_MS = 10;
    const delay = () => new Promise(resolve => setTimeout(resolve, LATENCY_MS));

    beforeEach(() => {
        jest.resetModules(); // Important to clear cache of required modules

        // Define mock Prisma instance methods
        mockPrisma = {
            user: {
                findFirst: jest.fn().mockImplementation(async (args: any) => {
                    await delay();
                    if (args?.where?.role === 'ADMIN') {
                        return { id: 'admin-id', role: 'ADMIN' };
                    }
                    return null;
                })
            },
            model: {
                upsert: jest.fn().mockImplementation(async () => { await delay(); throw new Error('Simulated Upsert Fail'); }),
                findFirst: jest.fn().mockImplementation(async () => { await delay(); return null; }),
                update: jest.fn().mockImplementation(async () => { await delay(); return {}; }),
                create: jest.fn().mockImplementation(async () => { await delay(); return {}; }),
                findMany: jest.fn().mockImplementation(async () => { await delay(); return []; }),
                createMany: jest.fn().mockImplementation(async () => { await delay(); return { count: 0 }; })
            }
        };

        // Mock @prisma/client
        jest.doMock('@prisma/client', () => {
            return {
                PrismaClient: jest.fn().mockImplementation(() => mockPrisma)
            };
        });

        // Mock axios
        jest.doMock('axios', () => ({
            get: jest.fn().mockResolvedValue({
                data: {
                    data: Array.from({ length: 50 }, (_, i) => ({
                        id: `gpt-model-${i}`,
                        object: 'model',
                        created: 1234567890,
                        owned_by: 'openai'
                    }))
                }
            })
        }));

        // Import the service AFTER mocking
        const { ModelSyncService } = require('./model-sync.service');
        service = new ModelSyncService();

        // Setup env
        process.env.OPENAI_API_KEY = 'mock-key';
    });

    afterEach(() => {
        delete process.env.OPENAI_API_KEY;
    });

    it('should measure sync performance', async () => {
        console.log('Starting sync...');
        const start = Date.now();
        await service.syncAll();
        const end = Date.now();
        const duration = end - start;

        const upsertCalls = mockPrisma.model.upsert.mock.calls.length;
        const findFirstCalls = mockPrisma.model.findFirst.mock.calls.length; // Includes admin check + model checks
        const updateCalls = mockPrisma.model.update.mock.calls.length;
        const createCalls = mockPrisma.model.create.mock.calls.length;
        const findManyCalls = mockPrisma.model.findMany.mock.calls.length;
        const createManyCalls = mockPrisma.model.createMany.mock.calls.length;

        const totalDbCalls = upsertCalls + findFirstCalls + updateCalls + createCalls + findManyCalls + createManyCalls;

        console.log('--- Performance Metrics ---');
        console.log(`Duration: ${duration}ms`);
        console.log(`Total DB Calls: ${totalDbCalls}`);
        console.log(`upsert calls: ${upsertCalls}`);
        console.log(`findFirst calls: ${findFirstCalls}`);
        console.log(`update calls: ${updateCalls}`);
        console.log(`create calls: ${createCalls}`);
        console.log(`findMany calls: ${findManyCalls}`);
        console.log(`createMany calls: ${createManyCalls}`);
        console.log('---------------------------');

        // Expectation with optimization:
        // 1 findMany (batch fetch)
        // 1 createMany (batch create)
        // (Admin check is on user table, not counted in model table calls here)
        // Total model calls = 2
        expect(totalDbCalls).toBeLessThan(10);
        expect(findManyCalls).toBe(1);
    });

    it('should handle updates efficiently', async () => {
        // Mock that all models exist
        mockPrisma.model.findMany.mockResolvedValue(
            Array.from({ length: 50 }, (_, i) => ({
                id: `existing-id-${i}`,
                api_provider: 'openai',
                api_model_id: `gpt-model-${i}`,
                name: 'Old Name'
            }))
        );

        console.log('Starting sync (Updates)...');
        const start = Date.now();
        await service.syncAll();
        const end = Date.now();
        const duration = end - start;

        const findManyCalls = mockPrisma.model.findMany.mock.calls.length;
        const updateCalls = mockPrisma.model.update.mock.calls.length;
        const createManyCalls = mockPrisma.model.createMany.mock.calls.length;

        console.log(`Update Duration: ${duration}ms`);
        console.log(`Update Calls: ${updateCalls}`);

        // 1 findMany
        // 50 updates (Promise.all)
        // 0 createMany
        expect(findManyCalls).toBeGreaterThanOrEqual(1); // Jest mocks might accumulate if not cleared
        expect(createManyCalls).toBe(0);
        expect(updateCalls).toBe(50);

        // Duration should be roughly 10ms (findMany) + 10ms (updates in parallel) + overhead
        // vs 50 * 10ms = 500ms sequentially
        expect(duration).toBeLessThan(200);
    });
});
