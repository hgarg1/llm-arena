import { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';
import { chatService } from '../services/chat.service';

export const globalSettingsMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.locals.settings = await settingsService.getAll();
        
        // Add unread chat count if user is logged in
        const userId = (req.session as any).userId;
        if (userId) {
            res.locals.unreadChatCount = await chatService.getUnreadCount(userId);
        } else {
            res.locals.unreadChatCount = 0;
        }
    } catch (e) {
        console.error("Failed to load global settings", e);
        res.locals.settings = settingsService.defaults;
        res.locals.unreadChatCount = 0;
    }
    next();
};
