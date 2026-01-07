import { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';

export const globalSettingsMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        res.locals.settings = await settingsService.getAll();
    } catch (e) {
        console.error("Failed to load global settings", e);
        res.locals.settings = settingsService.defaults;
    }
    next();
};
