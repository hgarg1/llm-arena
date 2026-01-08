import { Request, Response, NextFunction } from 'express';
import { chatService } from '../services/chat.service';
import { ChatChannelType } from '@prisma/client';
import { Server } from 'socket.io';

export const index = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const channels = await chatService.getChannelsForUser(userId);
        
        // If no channels, or to support the UI, pass them down
        res.render('chat/index', {
            title: 'Team Chat',
            channels,
            activeChannel: null
        });
    } catch (error) {
        next(error);
    }
};

export const getChannel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { id } = req.params;
        
        const channels = await chatService.getChannelsForUser(userId);
        const activeChannel = channels.find(c => c.id === id);

        if (!activeChannel) {
             // Try to join if not found in list but exists (handled by service logic usually, but here we just redirect)
             return res.redirect('/chat');
        }

        const messages = await chatService.getMessages(id);
        await chatService.markAsRead(userId, id);

        res.render('chat/index', {
            title: `#${activeChannel.name}`,
            channels,
            activeChannel,
            messages: messages.reverse() // Oldest first for chat UI
        });
    } catch (error) {
        next(error);
    }
};

export const createChannel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { name, description, type, min_role, entitlement } = req.body;

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        await chatService.createChannel(
            name,
            slug,
            type || ChatChannelType.PUBLIC,
            userId,
            { description, minRole: min_role, entitlement }
        );

        res.redirect('/chat');
    } catch (error) {
        // In a real app, flash error
        console.error(error);
        res.redirect('/chat');
    }
};

export const joinChannel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { id } = req.params;
        await chatService.joinChannel(userId, id);
        res.redirect(`/chat/channels/${id}`);
    } catch (error) {
        next(error);
    }
};

export const postMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { id } = req.params;
        const { content } = req.body;
        const files = req.files as Express.Multer.File[];

        const attachments: { filename: string, path: string, mimetype: string, size: number }[] = [];
        let type: any = 'TEXT';
        
        if (files && files.length > 0) {
            files.forEach(file => {
                attachments.push({
                    filename: file.originalname,
                    path: file.path,
                    mimetype: file.mimetype,
                    size: file.size
                });
            });
            // If images only, set type image? No, mixed. TEXT is default. 
            // If ONLY files and no text, maybe FILE? But we support both.
        }

        if ((!content || !content.trim()) && attachments.length === 0) {
            return res.redirect(`/chat/channels/${id}`);
        }

        const msg = await chatService.sendMessage(
            id, 
            userId, 
            content || (attachments.length > 0 ? `Shared ${attachments.length} file(s)` : ''), 
            type, 
            attachments
        );
        
        // Emit socket event
        const io: Server = req.app.get('io');
        if (io) {
            io.to(`channel:${id}`).emit('new_message', {
                ...msg,
                sender: {
                    name: res.locals.user.name || res.locals.user.email,
                    avatar_url: res.locals.user.avatar_url,
                    email: res.locals.user.email
                }
            });
        }
        
        // If it's an AJAX request (from file upload or enhanced UI), return JSON
        if (req.xhr || req.headers.accept?.includes('json')) {
            return res.json({ success: true, message: msg });
        }

        res.redirect(`/chat/channels/${id}`);
    } catch (error) {
        next(error);
    }
};

export const editMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { id, messageId } = req.params;
        const { content } = req.body;

        const updated = await chatService.editMessage(messageId, userId, content);

        const io: Server = req.app.get('io');
        if (io) {
            io.to(`channel:${id}`).emit('message_updated', {
                id: messageId,
                content: updated.content,
                is_edited: true
            });
        }

        res.json({ success: true, message: updated });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export const deleteMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { id, messageId } = req.params;

        await chatService.deleteMessage(messageId, userId);

        const io: Server = req.app.get('io');
        if (io) {
            io.to(`channel:${id}`).emit('message_deleted', {
                id: messageId
            });
        }

        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export const pollNotifications = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const notifications = await chatService.getPendingNotifications(userId);
        
        if (notifications.length > 0) {
            await chatService.markNotificationsAsSent(notifications.map(n => n.id));
        }

        res.json({ 
            notifications: notifications.map(n => ({
                id: n.id,
                title: `New message in #${n.channel.name}`,
                message: `${n.message.sender?.name || n.message.sender?.email || 'System'}: ${n.message.content}`,
                type: 'chat'
            }))
        });
    } catch (error) {
        // Silent error for poll
        res.json({ notifications: [] });
    }
};

export const startDM = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { targetUserId } = req.body;
        
        if (!targetUserId) {
            return res.status(400).send('Target user required');
        }

        const channel = await chatService.getOrCreateDM(userId, targetUserId);
        
        if (req.xhr || req.headers.accept?.includes('json')) {
            return res.json({ success: true, channelId: channel.id });
        }
        res.redirect(`/chat/channels/${channel.id}`);
    } catch (error: any) {
        if (req.xhr || req.headers.accept?.includes('json')) {
            return res.status(400).json({ success: false, message: error.message });
        }
        // Graceful error handling for page requests
        res.redirect(`/chat?error=${encodeURIComponent(error.message)}`);
    }
};

export const searchCandidates = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const query = req.query.q as string;
        const candidates = await chatService.getMsgCandidates(userId, query);
        res.json(candidates);
    } catch (error) {
        next(error);
    }
};

export const blockUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { targetId } = req.body;
        await chatService.blockUser(userId, targetId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export const unblockUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = res.locals.user.id;
        const { targetId } = req.body;
        await chatService.unblockUser(userId, targetId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
};
