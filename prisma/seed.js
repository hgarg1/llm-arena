"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma = new client_1.PrismaClient();
async function main() {
    const passwordHash = await bcrypt_1.default.hash('admin123', 10);
    // Create Admin User
    const admin = await prisma.user.upsert({
        where: { email: 'admin@llmarena.com' },
        update: {},
        create: {
            email: 'admin@llmarena.com',
            password_hash: passwordHash,
            role: 'ADMIN',
        },
    });
    console.log({ admin });
    // Create Mock Models
    const modelA = await prisma.model.create({
        data: {
            name: 'Negotiator Bot Alpha',
            description: 'A simple deterministic bot that favors splitting.',
            api_provider: 'mock',
            api_model_id: 'mock-v1',
            owner_id: admin.id
        }
    });
    const modelB = await prisma.model.create({
        data: {
            name: 'Aggressive Trader Beta',
            description: 'A bot that pushes for 60/40 splits.',
            api_provider: 'mock',
            api_model_id: 'mock-v1', // Using same mock logic for now, different name
            owner_id: admin.id
        }
    });
    const modelC = await prisma.model.create({
        data: {
            name: 'OpenAI GPT-4 (Stub)',
            description: 'Stub for GPT-4 integration.',
            api_provider: 'openai',
            api_model_id: 'gpt-4',
            owner_id: admin.id
        }
    });
    console.log({ modelA, modelB, modelC });
}
main()
    .then(async () => {
    await prisma.$disconnect();
})
    .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
