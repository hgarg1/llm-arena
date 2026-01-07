import { Request, Response, NextFunction } from 'express';
import { contentService } from '../services/content.service';

export const contentMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const content = await contentService.getAll();
        res.locals.content = content;
    } catch (e) {
        console.error("Failed to load content", e);
        res.locals.content = contentService.defaults;
    }
    next();
};
