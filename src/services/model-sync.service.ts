import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { ModelRepository } from '../repositories/model.repository';

const prisma = new PrismaClient();
const modelRepo = new ModelRepository();

interface ImportedModel {
  name: string;
  provider: string;
  modelId: string;
  description?: string;
}

export class ModelSyncService {
  
  async syncAll() {
    console.log('Starting model sync...');
    const models: ImportedModel[] = [];
    const defaultCapabilities = ['iterated-negotiation', 'chess', 'chutes_and_ladders', 'texas_holdem'];

    // 1. OpenAI
    if (process.env.OPENAI_API_KEY) {
      try {
        console.log('Fetching OpenAI models...');
        const res = await axios.get('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
        });
        const openAIModels = res.data.data
          .filter((m: any) => m.id.includes('gpt')) // Filter for chat models
          .map((m: any) => ({
            name: `OpenAI ${m.id}`,
            provider: 'openai',
            modelId: m.id,
            description: `Official OpenAI model: ${m.id}`
          }));
        models.push(...openAIModels);
        console.log(`Fetched ${openAIModels.length} OpenAI models.`);
      } catch (e: any) {
        console.error('Failed to sync OpenAI:', e.message);
      }
    } else {
        console.warn('Skipping OpenAI: OPENAI_API_KEY not set.');
    }

    // 2. Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        console.log('Fetching Anthropic models...');
        const res = await axios.get('https://api.anthropic.com/v1/models', {
            headers: { 
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            }
        });
        const anthropicModels = res.data.data.map((m: any) => ({
            name: `Anthropic ${m.display_name || m.id}`,
            provider: 'anthropic',
            modelId: m.id,
            description: `Official Anthropic model: ${m.display_name || m.id}`
        }));
        models.push(...anthropicModels);
        console.log(`Fetched ${anthropicModels.length} Anthropic models.`);
      } catch (e: any) {
          console.error('Failed to sync Anthropic:', e.message);
      }
    } else {
        console.warn('Skipping Anthropic: ANTHROPIC_API_KEY not set.');
    }

    // 3. Google Gemini
    if (process.env.GEMINI_API_KEY) {
        try {
            console.log('Fetching Google Gemini models...');
            const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
            const googleModels = res.data.models
                .filter((m: any) => m.name.includes('gemini'))
                .map((m: any) => ({
                    name: `Google ${m.displayName}`,
                    provider: 'google',
                    modelId: m.name.replace('models/', ''), // API returns "models/gemini-pro"
                    description: m.description
                }));
            models.push(...googleModels);
            console.log(`Fetched ${googleModels.length} Google models.`);
        } catch (e: any) {
            console.error('Failed to sync Google:', e.message);
        }
    } else {
        console.warn('Skipping Google: GEMINI_API_KEY not set.');
    }

    // 4. xAI (Grok)
    if (process.env.XAI_API_KEY) {
        try {
            console.log('Fetching xAI (Grok) models...');
            const res = await axios.get('https://api.x.ai/v1/models', {
                headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
            });
            const xaiModels = res.data.data.map((m: any) => ({
                name: `xAI ${m.id}`,
                provider: 'xai',
                modelId: m.id,
                description: `Official xAI model: ${m.id}`
            }));
            models.push(...xaiModels);
            console.log(`Fetched ${xaiModels.length} xAI models.`);
        } catch (e: any) {
            console.error('Failed to sync xAI:', e.message);
        }
    } else {
        console.warn('Skipping xAI: XAI_API_KEY not set.');
    }

    // 5. Z.ai (Zhipu)
    if (process.env.ZHIPU_API_KEY) {
        try {
            console.log('Fetching Z.ai (Zhipu) models...');
            const res = await axios.get('https://open.bigmodel.cn/api/paas/v4/models', {
                headers: { Authorization: `Bearer ${process.env.ZHIPU_API_KEY}` }
            });
            
            const zhipuModels = res.data.data.map((m: any) => ({
                name: `Zhipu ${m.id}`,
                provider: 'zhipu',
                modelId: m.id,
                description: `Official Z.ai model: ${m.id}`
            }));
            models.push(...zhipuModels);
            console.log(`Fetched ${zhipuModels.length} Zhipu models.`);
        } catch (e: any) {
             console.error('Failed to sync Zhipu:', e.message);
        }
    } else {
        console.warn('Skipping Zhipu: ZHIPU_API_KEY not set.');
    }

    // Upsert models to DB
    console.log(`Upserting ${models.length} models to database...`);
    if (models.length === 0) {
        console.log('No models to sync.');
        return;
    }

    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) {
        throw new Error('No admin user found. Please run seed script first.');
    }

    // Optimization: Batch operations to avoid N+1 queries
    // 1. Fetch existing models
    const existingModels = await prisma.model.findMany({
        where: {
            OR: models.map(m => ({
                api_provider: m.provider,
                api_model_id: m.modelId
            }))
        }
    });

    const existingMap = new Map<string, string>();
    for (const em of existingModels) {
        existingMap.set(`${em.api_provider}:${em.api_model_id}`, em.id);
    }

    const toCreate: any[] = [];
    const toUpdate: { id: string; data: any }[] = [];

    for (const m of models) {
        const key = `${m.provider}:${m.modelId}`;
        if (existingMap.has(key)) {
            toUpdate.push({
                id: existingMap.get(key)!,
                data: {
                    name: m.name,
                    description: m.description,
                    capabilities: defaultCapabilities,
                    updated_at: new Date()
                }
            });
        } else {
            toCreate.push({
                name: m.name,
                description: m.description,
                api_provider: m.provider,
                api_model_id: m.modelId,
                owner_id: admin.id,
                capabilities: defaultCapabilities
            });
        }
    }

    if (toCreate.length > 0) {
        await prisma.model.createMany({
            data: toCreate,
            skipDuplicates: true
        });
        console.log(`Created ${toCreate.length} new models.`);
    }

    if (toUpdate.length > 0) {
        // Parallelize updates
        await Promise.all(toUpdate.map(u =>
            prisma.model.update({
                where: { id: u.id },
                data: u.data
            })
        ));
        console.log(`Updated ${toUpdate.length} existing models.`);
    }

    console.log('Sync complete.');
  }
}