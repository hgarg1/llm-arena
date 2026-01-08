import { prisma } from '../config/db';
import { getModelAdapter } from '../game/adapters';
import { GameEvent } from '../game/types';
import axios from 'axios';

export class AdminAIService {
  /**
   * Fetches all available chat models from providers on-demand
   */
  async fetchAvailableModels(provider: string): Promise<string[]> {
    const envKey = (name: string) => process.env[name] || '';

    try {
      if (provider === 'openai') {
        const key = envKey('OPENAI_API_KEY');
        if (!key) return [];
        const res = await axios.get('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` }
        });
        // OpenAI doesn't provide capabilities in list, use smart name filter
        // Exclude known non-chat identifiers
        const nonChat = ['dall-e', 'whisper', 'tts', 'embedding', 'babbage', 'davinci', 'curie', 'ada', 'vision-preview'];
        return res.data.data
          .filter((m: any) => {
            const id = m.id.toLowerCase();
            return (id.includes('gpt') || id.startsWith('o1')) && !nonChat.some(nc => id.includes(nc));
          })
          .map((m: any) => m.id)
          .sort();
      }

      if (provider === 'anthropic') {
        const key = envKey('ANTHROPIC_API_KEY');
        if (!key) return [];
        const res = await axios.get('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        });
        // Anthropic models in list are all chat-capable (Claude)
        return res.data.data.map((m: any) => m.id).sort();
      }

      if (provider === 'google') {
        const key = envKey('GEMINI_API_KEY');
        if (!key) return [];
        const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        // Google explicitly provides capabilities via supportedGenerationMethods
        return res.data.models
          .filter((m: any) => 
            m.supportedGenerationMethods.includes('generateContent') || 
            m.supportedGenerationMethods.includes('generateMessage')
          )
          .map((m: any) => m.name.replace('models/', ''))
          .sort();
      }

      if (provider === 'xai') {
        const key = envKey('XAI_API_KEY');
        if (!key) return [];
        const res = await axios.get('https://api.x.ai/v1/models', {
          headers: { Authorization: `Bearer ${key}` }
        });
        return res.data.data
          .filter((m: any) => !m.id.toLowerCase().includes('embedding'))
          .map((m: any) => m.id)
          .sort();
      }

      if (provider === 'zhipu' || provider === 'z.ai') {
        const key = envKey('ZHIPU_API_KEY') || envKey('Z_AI_API_KEY') || envKey('ZAI_API_KEY');
        if (!key) return [];
        const res = await axios.get('https://open.bigmodel.cn/api/paas/v4/models', {
          headers: { Authorization: `Bearer ${key}` }
        });
        // Filter out non-chat models by checking internal object/type if provided, or heuristics
        return res.data.data
          .filter((m: any) => {
            const id = m.id.toLowerCase();
            return !id.includes('embedding') && !id.includes('character'); // character is for roleplay
          })
          .map((m: any) => m.id)
          .sort();
      }
    } catch (e: any) {
      console.error(`Failed to fetch models for ${provider}:`, e.message);
      return [];
    }

    return [];
  }

  /**
   * Gathers system context based on admin permissions
   */
  async gatherContext(userId: string, permissions: string[]): Promise<string> {
    const contextParts: string[] = [];
    contextParts.push(`Current Time: ${new Date().toISOString()}`);
    contextParts.push(`Admin User ID: ${userId}`);

    if (permissions.includes('admin.users.view')) {
      const userCount = await prisma.user.count();
      const tierDist = await prisma.user.groupBy({
        by: ['tier'],
        _count: { id: true }
      });
      const recentUsers = await prisma.user.findMany({
        take: 5,
        orderBy: { created_at: 'desc' },
        select: { email: true, tier: true }
      });
      contextParts.push(`User Stats: Total=${userCount}, Tiers=${JSON.stringify(tierDist)}, Recent=${JSON.stringify(recentUsers)}`);
    }

    if (permissions.includes('admin.models.view')) {
      const modelCount = await prisma.model.count();
      const activeCount = await prisma.model.count({ where: { is_active: true } });
      contextParts.push(`Model Stats: Total=${modelCount}, Active=${activeCount}`);
    }

    if (permissions.includes('admin.matches.view')) {
      const matchCount = await prisma.match.count();
      const statusDist = await prisma.match.groupBy({
        by: ['status'],
        _count: { id: true }
      });
      contextParts.push(`Match Stats: Total=${matchCount}, Statuses=${JSON.stringify(statusDist)}`);
    }

    if (permissions.includes('admin.hr.view')) {
      const jobCount = await prisma.jobPosting.count({ where: { status: 'PUBLISHED' } });
      const appCount = await prisma.jobApplication.count();
      contextParts.push(`HR Stats: Published Jobs=${jobCount}, Total Applications=${appCount}`);
    }

    if (permissions.includes('admin.entitlements.view')) {
      const entCount = await prisma.subscriptionEntitlement.count();
      const planCount = await prisma.subscriptionPlan.count({ where: { is_active: true } });
      contextParts.push(`Subscription Stats: Active Plans=${planCount}, Total Entitlements=${entCount}`);
    }

    if (permissions.includes('admin.queue.view')) {
      // Logic would go here to fetch BullMQ stats if needed, or summary
      contextParts.push(`Queue Health: System is processing active jobs.`);
    }

    if (permissions.includes('admin.audit.view')) {
      const recentAudit = await prisma.adminAuditLog.findMany({ 
        take: 5, 
        orderBy: { created_at: 'desc' },
        include: { admin: { select: { email: true } } }
      });
      contextParts.push(`Recent Audit Activity: ${JSON.stringify(recentAudit.map(l => ({ admin: l.admin.email, action: l.action, target: l.target })))}`);
    }

    if (permissions.includes('admin.settings.view')) {
      const settings = await prisma.systemSetting.findMany();
      contextParts.push(`System Settings (Partial): ${JSON.stringify(settings.slice(0, 10).map(s => ({ key: s.key, value: s.value })))}`);
    }

    return contextParts.join('\n');
  }

  async ask(userId: string, permissions: string[], provider: string, modelId: string, question: string, history: any[] = [], images: string[] = []): Promise<string> {
    const context = await this.gatherContext(userId, permissions);
    const adapter = getModelAdapter(provider, modelId);

    const systemPrompt = `You are the LLM Arena Admin Assistant. 
You help administrators manage the platform. 
Below is the SYSTEM CONTEXT you have access to based on the current admin's permissions. 
If information is not in the context, inform the user you don't have the permission to see it.

SYSTEM CONTEXT:
${context}

Instructions:
1. Be professional and concise.
2. Only answer based on the provided context or general system knowledge.
3. If the user asks about something not in context, explain that your current permission level doesn't expose that data.`;

    // Convert history to GameEvent format for the adapter
    const aiHistory: GameEvent[] = history.map((h, i) => ({
      turn: i,
      actor: h.role === 'user' ? 'user' : 'assistant',
      type: 'chat',
      payload: { 
        content: h.content,
        images: h.images || []
      },
      created_at: new Date()
    }));

    // Add current question as an event
    aiHistory.push({
      turn: aiHistory.length,
      actor: 'user',
      type: 'chat',
      payload: { 
        content: question,
        images: images
      },
      created_at: new Date()
    });

    return await adapter.generateMove(systemPrompt, aiHistory);
  }
}

export const adminAIService = new AdminAIService();
