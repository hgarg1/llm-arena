import { Request, Response, NextFunction } from 'express';
import { chatService } from '../services/chat.service';
import { ChatChannelType } from '@prisma/client';

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

        if (!content || !content.trim()) {
            return res.redirect(`/chat/channels/${id}`);
        }

        await chatService.sendMessage(id, userId, content);
        
        res.redirect(`/chat/channels/${id}`);
    } catch (error) {
        next(error);
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
