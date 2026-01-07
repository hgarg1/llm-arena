import { Request, Response, NextFunction } from 'express';
import { adminAIService } from '../../services/admin-ai.service';

export const index = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const providers = [
            { id: 'openai', name: 'OpenAI' },
            { id: 'anthropic', name: 'Anthropic' },
            { id: 'google', name: 'Google' },
            { id: 'xai', name: 'Grok (xAI)' },
            { id: 'z.ai', name: 'Z.AI' }
        ];

        res.render('admin/ai-chat/index', {
            title: 'Admin AI Assistant',
            path: '/admin/ai-chat',
            providers
        });
    } catch (error) {
        next(error);
    }
};

export const getModels = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { provider } = req.params;
        const models = await adminAIService.fetchAvailableModels(provider);
        res.json({ models });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

export const query = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { provider, model, question, history, images } = req.body;
        const userId = (req.session as any).userId;
        const permissions = res.locals.permissions || [];

        if (!question && (!images || images.length === 0)) {
            return res.status(400).json({ error: 'Question or image is required' });
        }

        const response = await adminAIService.ask(
            userId,
            permissions,
            provider || 'openai',
            model || 'gpt-4',
            question,
            history || [],
            images || []
        );

        res.json({ response });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'AI processing failed' });
    }
};

export const exportChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'No messages to export' });
        }

        const data = JSON.stringify(messages, null, 2);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="admin-ai-export-${Date.now()}.json"`);
        res.send(data);
    } catch (error) {
        next(error);
    }
};