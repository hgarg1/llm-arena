import { Request, Response } from 'express';
import { contentService } from '../../services/content.service';
import { logAdminAction } from '../../services/audit.service';

export const contentList = async (req: Request, res: Response) => {
    const content = await contentService.getAll();
    
    // Group by namespace
    const groups: Record<string, string[]> = {};
    Object.keys(contentService.defaults).forEach(key => {
        const [scope, page] = key.split(':'); // e.g. "investor", "home"
        const groupName = `${scope.toUpperCase()} - ${page.toUpperCase()}`;
        if (!groups[groupName]) groups[groupName] = [];
        groups[groupName].push(key);
    });

    res.render('admin/content/index', { 
        title: 'Content Management', 
        path: '/admin/content', 
        content,
        groups
    });
};

export const updateContent = async (req: Request, res: Response) => {
    const { key, value } = req.body;
    
    try {
        await contentService.update(key, value);
        await logAdminAction((req.session as any).userId, 'content.update', key);
        res.redirect('/admin/content?success=Updated ' + key);
    } catch (e) {
        console.error(e);
        res.redirect('/admin/content?error=Update failed');
    }
};
