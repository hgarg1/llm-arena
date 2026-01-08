import { Request, Response, NextFunction } from 'express';
import { prisma as db } from '../../config/db';
import { sentimentService } from '../../services/sentiment.service';
import { logAdminAction } from '../../services/audit.service';
import { chatService } from '../../services/chat.service';

export const index = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [channels, totalMessages, messagesToday, distinctPosters, sentiment, roles, entitlements] = await Promise.all([
            db.chatChannel.findMany({
                include: {
                    creator: true,
                    _count: {
                        select: { participants: true, messages: true }
                    }
                },
                orderBy: { created_at: 'desc' }
            }),
            db.chatMessage.count(),
            db.chatMessage.count({
                where: { created_at: { gte: today } }
            }),
            db.chatMessage.groupBy({
                by: ['user_id'],
                where: { created_at: { gte: today }, user_id: { not: null } },
            }),
            sentimentService.getSystemSentiment(),
            db.rbacRole.findMany(),
            db.subscriptionEntitlement.findMany()
        ]);

        const activeUsers = distinctPosters.length;

        // Mock data for chart (last 7 days) - Real implementation would need raw query or separate aggregation table
        const chartData = {
            labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            data: [12, 19, 3, 5, 2, 3, messagesToday] 
        };

        // Fetch Global Settings (using SystemSetting table)
        const globalSettings = await db.systemSetting.findMany({
            where: { key: { startsWith: 'chat_' } }
        });
        const settingsMap = globalSettings.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});

        res.render('admin/chat/index', {
            title: 'Chat Management',
            channels,
            stats: {
                totalMessages,
                messagesToday,
                activeUsers,
                totalChannels: channels.length,
                sentiment
            },
            settings: settingsMap,
            roles,
            entitlements,
            chartData: JSON.stringify(chartData),
            path: '/admin/chat'
        });
    } catch (error) {
        next(error);
    }
};

export const createChannel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, description, type, min_role_required, entitlement_required } = req.body;
        const userId = (req.session as any).userId;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Validation: Check if admin can assign this role
        if (min_role_required) {
            const admin = await db.user.findUnique({
                where: { id: userId },
                include: { rbac_roles: { include: { role: true } } }
            });
            
            if (admin?.role !== 'ADMIN') {
                // If not Global Admin, check specific roles
                const myRoles = admin?.rbac_roles.map(r => r.role.name) || [];
                if (!myRoles.includes(min_role_required)) {
                    // Cannot assign a role you don't have
                    return res.redirect('/admin/chat?error=Insufficient permissions to assign this role');
                }
            }
        }

        await chatService.createChannel(name, slug, type, userId, {
            description,
            minRole: min_role_required || undefined,
            entitlement: entitlement_required || undefined
        });

        await logAdminAction(userId, 'admin.chat.create', 'chat_channel', { name, slug, type });

        res.redirect('/admin/chat?success=Channel created');
    } catch (error) {
        // If error (e.g. duplicate slug), log and redirect with error
        // For MVP, just next(error) or redirect
        next(error);
    }
};

export const deleteChannel = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const userId = (req.session as any).userId;
        
        await db.chatChannel.delete({ where: { id } });
        
        await logAdminAction(userId, 'admin.chat.delete', 'chat_channel', { channel_id: id });

        res.redirect('/admin/chat');
    } catch (error) {
        next(error);
    }
};

export const broadcastAlert = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { message } = req.body;
        const userId = (req.session as any).userId;

        if (!message) return res.redirect('/admin/chat');

        // Logic to send to all public channels
        const publicChannels = await db.chatChannel.findMany({ where: { type: 'PUBLIC' } });
        
        for (const channel of publicChannels) {
            await chatService.sendMessage(channel.id, userId, `📢 SYSTEM ALERT: ${message}`, 'SYSTEM');
        }

        await logAdminAction(userId, 'admin.chat.broadcast', 'system', { message, channels_count: publicChannels.length });

        res.redirect('/admin/chat?success=Broadcast sent');
    } catch (error) {
        next(error);
    }
};

export const updateGlobalSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = (req.session as any).userId;
        const { chat_maintenance_mode, chat_global_rate_limit } = req.body;

        await Promise.all([
            db.systemSetting.upsert({
                where: { key: 'chat_maintenance_mode' },
                update: { value: chat_maintenance_mode ? 'true' : 'false' },
                create: { key: 'chat_maintenance_mode', value: chat_maintenance_mode ? 'true' : 'false' }
            }),
            db.systemSetting.upsert({
                where: { key: 'chat_global_rate_limit' },
                update: { value: chat_global_rate_limit || '0' },
                create: { key: 'chat_global_rate_limit', value: chat_global_rate_limit || '0' }
            })
        ]);

        await logAdminAction(userId, 'admin.chat.settings_update', 'system', { 
            chat_maintenance_mode: !!chat_maintenance_mode,
            chat_global_rate_limit 
        });

        res.redirect('/admin/chat?success=Settings updated');
    } catch (error) {
        next(error);
    }
};

export const configureChannelPage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const channel = await db.chatChannel.findUnique({ where: { id } });
        if (!channel) return res.redirect('/admin/chat');

        const entitlements = await db.subscriptionEntitlement.findMany();
        const roles = await db.rbacRole.findMany();

        res.render('admin/chat/configure', {
            title: `Configure #${channel.name}`,
            channel,
            entitlements,
            roles,
            path: '/admin/chat'
        });
    } catch (error) {
        next(error);
    }
};

export const updateChannelConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const userId = (req.session as any).userId;
        const { is_read_only, rate_limit, min_role_required, entitlement_required, type } = req.body;

        await db.chatChannel.update({
            where: { id },
            data: {
                is_read_only: !!is_read_only,
                rate_limit: parseInt(rate_limit) || 0,
                min_role_required: min_role_required || null,
                entitlement_required: entitlement_required || null,
                type
            }
        });

        await logAdminAction(userId, 'admin.chat.update', 'chat_channel', { 
            channel_id: id,
            updates: { is_read_only: !!is_read_only, rate_limit, min_role_required, entitlement_required, type }
        });

        res.redirect('/admin/chat');
    } catch (error) {
        next(error);
    }
};
