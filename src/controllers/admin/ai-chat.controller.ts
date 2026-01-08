import { Request, Response, NextFunction } from 'express';
import { adminAIService } from '../../services/admin-ai.service';
import { adminChatService } from '../../services/admin-chat.service';
import { logAdminAction } from '../../services/audit.service';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import { prisma } from '../../config/db';
import { matchQueue } from '../../services/queue';
import { redisConnection } from '../../config/redis';

const countActiveSessions = async () => {
    let cursor = '0';
    let count = 0;
    try {
        do {
            const result = await redisConnection.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 1000);
            cursor = result[0];
            count += result[1].length;
        } while (cursor !== '0');
    } catch (e) {
        console.error('Failed to count sessions from Redis', e);
        return 0; // Fail safe
    }
    return count;
};

export const index = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        
        const [chats, queueCounts, activeSessions, activeMatches] = await Promise.all([
            adminChatService.getChats(userId),
            matchQueue.getJobCounts('active', 'waiting', 'failed'),
            countActiveSessions(),
            prisma.match.count({ where: { status: 'RUNNING' } })
        ]);

        const stats = {
            queue: queueCounts,
            activeUsers: activeSessions,
            activeMatches,
            systemHealth: queueCounts.failed > 50 ? 'Critical' : (queueCounts.failed > 10 ? 'Degraded' : 'Healthy')
        };
        
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
            providers,
            chats,
            stats,
            selectedChatId: req.query.chatId || null
        });
    } catch (error) {
        next(error);
    }
};

export const createChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        const { provider, model } = req.body;
        const chat = await adminChatService.createChat(userId, provider || 'openai', model || 'gpt-4o');
        await logAdminAction(userId, 'ai_chat.create', chat.id, { provider, model });
        res.json(chat);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
};

export const deleteChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        const { id } = req.params;
        await adminChatService.deleteChat(id, userId);
        await logAdminAction(userId, 'ai_chat.delete', id);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
};

export const renameChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        const { id } = req.params;
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required' });
        
        await adminChatService.renameChat(id, userId, title);
        await logAdminAction(userId, 'ai_chat.rename', id, { title });
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
};

export const getChatHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        const { id } = req.params;
        const chat = await adminChatService.getChat(id, userId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        res.json(chat);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
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
        const { chatId, provider, model, question, images } = req.body;
        const userId = (req.session as any).userId;
        const permissions = res.locals.permissions || [];

        if (!chatId) {
             return res.status(400).json({ error: 'Chat ID is required' });
        }
        
        if (!question && (!images || images.length === 0)) {
            return res.status(400).json({ error: 'Question or image is required' });
        }

        const message = await adminChatService.sendMessage(
            userId,
            chatId,
            question,
            provider,
            model,
            permissions,
            images || []
        );

        await logAdminAction(userId, 'ai_chat.query', chatId, { model, provider, length: question?.length });
        res.json({ message });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'AI processing failed' });
    }
};

export const exportChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
         const { chatId, messages, format } = req.body; // format: 'json' | 'md' | 'docx' | 'xlsx' 
         const userId = (req.session as any).userId;
         
         let dataToExport = messages;
         let title = 'admin-ai-export';

         if (chatId) {
             const chat = await adminChatService.getChat(chatId, userId);
             if (chat) {
                 dataToExport = chat.messages;
                 title = chat.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
             }
         }

        if (!dataToExport || !Array.isArray(dataToExport)) {
            return res.status(400).json({ error: 'No messages to export' });
        }

        const filename = `${title}-${Date.now()}`;
        await logAdminAction(userId, 'ai_chat.export', chatId, { format: format || 'json' });

        if (format === 'md') {
             const mdContent = dataToExport.map((m: any) => `**${m.role.toUpperCase()}**: ${m.content}\n`).join('\n---\n\n');
             res.setHeader('Content-Type', 'text/markdown');
             res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
             return res.send(mdContent);
        }

        if (format === 'xlsx') {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Chat History');
            sheet.columns = [
                { header: 'Time', key: 'created_at', width: 20 },
                { header: 'Role', key: 'role', width: 10 },
                { header: 'Content', key: 'content', width: 80 },
                { header: 'Images', key: 'images', width: 30 }
            ];
            
            dataToExport.forEach((m: any) => {
                sheet.addRow({
                    created_at: m.created_at || new Date().toISOString(),
                    role: m.role,
                    content: m.content,
                    images: (m.images || []).join(', ')
                });
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
            const buffer = await workbook.xlsx.writeBuffer();
            return res.send(Buffer.from(buffer as ArrayBuffer));
        }

        if (format === 'docx') {
             const doc = new Document({
                 sections: [{
                     properties: {},
                     children: dataToExport.flatMap((m: any) => [
                         new Paragraph({
                             children: [
                                 new TextRun({
                                     text: `${m.role.toUpperCase()}:`,
                                     bold: true,
                                     size: 24
                                 })
                             ],
                             spacing: { before: 200, after: 100 }
                         }),
                         new Paragraph({
                             children: [
                                 new TextRun({
                                     text: m.content,
                                     size: 24
                                 })
                             ]
                         }),
                         ...(m.images && m.images.length > 0 ? [
                            new Paragraph({
                                children: [
                                    new TextRun({
                                        text: `[Attached Images: ${m.images.length}]`,
                                        italics: true,
                                        size: 20
                                    })
                                ]
                            })
                         ] : [])
                     ])
                 }]
             });
             
             const buffer = await Packer.toBuffer(doc);
             res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
             res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
             return res.send(buffer);
        }

        // Default JSON
        const data = JSON.stringify(dataToExport, null, 2);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
        res.send(data);
    } catch (error) {
        next(error);
    }
};