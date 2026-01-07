import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { matchQueue } from '../services/queue';
import { apiKeyScopesForAdmin } from './admin/api-keys.controller';
import { MatchStatus } from '@prisma/client';
import bcrypt from 'bcrypt';
import { settingsService } from '../services/settings.service';
import { contentService } from '../services/content.service';
import { comms } from '../services/communication';
import { logAdminAction } from '../services/audit.service';
import { addDataRows, applyColumnSizing, createStyledSheet, createWorkbook } from '../services/excel-export.service';

const mapPlanLevelToTier = (level: number) => {
    if (level >= 3) return 'ENTERPRISE';
    if (level >= 2) return 'PRO';
    return 'FREE';
};

const getEnterprisePlan = async () => {
    return prisma.subscriptionPlan.findFirst({
        where: { is_active: true, level: { gte: 3 } },
        orderBy: { level: 'desc' }
    });
};

export const dashboard = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Gather Comprehensive Stats
    const [
        userCount, 
        modelCount, 
        matchCount, 
        runningMatches,
        failedMatches,
        dashboard,
        matchesByGame,
        recentSignups,
        recentMatches,
        queueCounts,
        auditLogs,
        // New Data Points
        activeSubscriptions,
        pendingApprovals,
        totalApiKeys,
        openJobs,
        totalApplications,
        totalChannels,
        messagesToday,
        activeModels,
        accessDeniedCount,
        tierDistribution
    ] = await Promise.all([
        prisma.user.count(),
        prisma.model.count(),
        prisma.match.count(),
        prisma.match.count({ where: { status: 'RUNNING' } }),
        prisma.match.count({ where: { status: 'FAILED' } }),
        prisma.adminDashboard.findUnique({ where: { user_id: userId } }),
        prisma.match.groupBy({ by: ['game_type'], _count: { id: true } }),
        prisma.user.findMany({
            take: 10,
            orderBy: { created_at: 'desc' },
            select: { email: true, created_at: true, tier: true }
        }),
        prisma.match.findMany({
            take: 10,
            orderBy: { created_at: 'desc' },
            include: { created_by: { select: { email: true } } }
        }),
        matchQueue.getJobCounts('active', 'waiting', 'completed', 'failed'),
        prisma.adminAuditLog.findMany({
            take: 10,
            orderBy: { created_at: 'desc' },
            include: { admin: { select: { email: true } } }
        }),
        prisma.stripeSubscription.count({ where: { status: 'active' } }),
        prisma.adminAccessRequest.count({ where: { status: 'PENDING' } }),
        prisma.apiKey.count({ where: { status: 'ACTIVE' } }),
        prisma.jobPosting.count({ where: { status: 'PUBLISHED' } }),
        prisma.jobApplication.count(),
        prisma.chatChannel.count(),
        prisma.chatMessage.count({ where: { created_at: { gte: today } } }),
        prisma.model.count({ where: { is_active: true } }),
        prisma.adminAuditLog.count({ where: { action: 'access.denied' } }),
        prisma.user.groupBy({ by: ['tier'], _count: { id: true } })
    ]);

    const layout = dashboard ? dashboard.layout : null;

    res.render('admin/dashboard', {
        title: 'Admin Dashboard',
        path: '/admin',
        stats: {
            userCount,
            modelCount,
            matchCount,
            runningMatches,
            failedMatches,
            queueCounts,
            activeSubscriptions,
            pendingApprovals,
            totalApiKeys,
            openJobs,
            totalApplications,
            totalChannels,
            messagesToday,
            activeModels,
            accessDeniedCount,
            tierDistribution
        },
        recentMatches,
        recentSignups,
        matchesByGame,
        auditLogs,
        layout: JSON.stringify(layout)
    });
};

export const userList = async (req: Request, res: Response) => {
    const { q, role, tier, plan_id } = req.query;
    
    const where: any = {};
    if (q) {
        where.OR = [
            { email: { contains: q as string, mode: 'insensitive' } },
            { name: { contains: q as string, mode: 'insensitive' } }
        ];
    }
    if (role) where.role = role;
    if (tier) where.tier = tier;
    if (plan_id === 'none') {
        where.plan_id = null;
    } else if (plan_id) {
        where.plan_id = plan_id;
    }

    const [users, plans] = await Promise.all([
        prisma.user.findMany({
            where,
            orderBy: { created_at: 'desc' },
            take: 50,
            include: {
                plan: true,
                _count: {
                    select: { matches: true }
                }
            }
        }),
        prisma.subscriptionPlan.findMany({
            where: { is_active: true },
            orderBy: [{ level: 'asc' }, { name: 'asc' }]
        })
    ]);
    
    res.render('admin/users/list', { 
        title: 'User Management', 
        path: '/admin/users', 
        users,
        plans,
        query: req.query 
    });
};

export const modelList = async (req: Request, res: Response) => {
    const { q, provider, capability, owner, kind, active, model: selectedModelId } = req.query;
    const where: any = {};
    if (q) {
        where.OR = [
            { name: { contains: q as string, mode: 'insensitive' } },
            { api_model_id: { contains: q as string, mode: 'insensitive' } }
        ];
    }
    if (provider) where.api_provider = provider;
    if (capability) where.capabilities = { has: capability };
    if (owner) where.owner_id = owner === 'system' ? null : owner;
    if (kind) where.kind = kind;
    if (active === 'true') where.is_active = true;
    if (active === 'false') where.is_active = false;

    const [models, owners, singleModels, selectedModel] = await Promise.all([
        prisma.model.findMany({
            where,
            orderBy: { created_at: 'desc' },
            include: {
                owner: { select: { id: true, email: true } },
                composite: {
                    include: {
                        members: { include: { member: true } },
                        pipeline_steps: { include: { member: true }, orderBy: { position: 'asc' } }
                    }
                }
            },
            take: 100
        }),
        prisma.user.findMany({
            orderBy: { email: 'asc' },
            select: { id: true, email: true }
        }),
        prisma.model.findMany({
            where: { kind: 'SINGLE' },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, api_provider: true, api_model_id: true }
        }),
        selectedModelId
            ? prisma.model.findUnique({
                where: { id: selectedModelId as string },
                include: {
                    owner: { select: { id: true, email: true } },
                    composite: {
                        include: {
                            members: { include: { member: true } },
                            pipeline_steps: { include: { member: true }, orderBy: { position: 'asc' } }
                        }
                    }
                }
            })
            : Promise.resolve(null)
    ]);

    const providers = Array.from(new Set(models.map(m => m.api_provider))).sort();
    const capabilities = Array.from(new Set(models.flatMap(m => m.capabilities || []))).sort();

    res.render('admin/models/list', {
        title: 'Model Management',
        path: '/admin/models',
        models,
        owners,
        singleModels,
        providers,
        capabilities,
        selectedModel,
        query: req.query,
        debugPermissions: req.query.debug === 'permissions',
        success: req.query.success,
        error: req.query.error
    });
};

const parseCapabilities = (value?: string) =>
    (value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

type CompositeMemberInput = { id: string; weight: number; position: number };
type PipelineStepInput = { id: string; position: number; prompt: string };

const parseCompositeMembers = (body: any): CompositeMemberInput[] => {
    const memberIds = Array.isArray(body.member_ids)
        ? body.member_ids
        : body.member_ids
            ? [body.member_ids]
            : [];
    const members = memberIds.map((id: string) => {
        const weightRaw = body[`weight_${id}`];
        const positionRaw = body[`position_${id}`];
        const weight = Math.max(1, parseInt(weightRaw || '1', 10));
        const position = Math.max(0, parseInt(positionRaw || '0', 10));
        return { id, weight, position };
    });
    return members.sort((a: CompositeMemberInput, b: CompositeMemberInput) => a.position - b.position);
};

const parsePipelineSteps = (body: any): PipelineStepInput[] => {
    const memberIds = Array.isArray(body.pipeline_member_ids)
        ? body.pipeline_member_ids
        : body.pipeline_member_ids
            ? [body.pipeline_member_ids]
            : [];
    const steps = memberIds.map((id: string) => {
        const positionRaw = body[`pipeline_position_${id}`];
        const position = Math.max(0, parseInt(positionRaw || '0', 10));
        const prompt = (body[`pipeline_prompt_${id}`] || '').trim();
        return { id, position, prompt };
    });
    return steps.sort((a: PipelineStepInput, b: PipelineStepInput) => a.position - b.position);
};

export const createModel = async (req: Request, res: Response) => {
    const { name, description, api_provider, api_model_id, owner_id } = req.body;
    if (!name || !api_provider || !api_model_id) {
        return res.redirect('/admin/models?error=Missing required fields');
    }
    if (api_provider === 'composite') {
        return res.redirect('/admin/models?error=Composite models must be created from the composite form');
    }

    try {
        const model = await prisma.model.create({
            data: {
                name,
                description: description || null,
                api_provider,
                api_model_id,
                owner_id: owner_id === 'system' || !owner_id ? null : owner_id,
                capabilities: parseCapabilities(req.body.capabilities),
                is_active: req.body.is_active ? true : false,
                kind: 'SINGLE'
            }
        });
        await logAdminAction((req.session as any).userId, 'model.create', model.id, { provider: api_provider });
        res.redirect(`/admin/models?success=Model created&model=${model.id}`);
    } catch (e) {
        console.error(e);
        res.redirect('/admin/models?error=Failed to create model');
    }
};

export const createCompositeModel = async (req: Request, res: Response) => {
    const { name, description, owner_id, strategy } = req.body;
    if (!name) {
        return res.redirect('/admin/models?error=Composite name is required');
    }
    const members = parseCompositeMembers(req.body);
    if (members.length < 2) {
        return res.redirect('/admin/models?error=Select at least two member models');
    }
    const pipelineSteps = parsePipelineSteps(req.body);
    if (strategy === 'PIPELINE' && pipelineSteps.length < 2) {
        return res.redirect('/admin/models?error=Pipeline requires at least two steps');
    }

    try {
        const memberModels: Array<{ id: string; capabilities: string[] }> = await prisma.model.findMany({
            where: { id: { in: members.map(m => m.id) }, kind: 'SINGLE' },
            select: { id: true, capabilities: true }
        });
        if (memberModels.length !== members.length) {
            return res.redirect('/admin/models?error=Composite members must be non-composite models');
        }

        const capabilityInput = parseCapabilities(req.body.capabilities);
        const derivedCaps = Array.from(new Set(memberModels.flatMap((m: { capabilities: string[] }) => m.capabilities)));
        const capabilities = capabilityInput.length > 0 ? capabilityInput : derivedCaps;

        const model = await prisma.model.create({
            data: {
                name,
                description: description || null,
                api_provider: 'composite',
                api_model_id: 'composite',
                owner_id: owner_id === 'system' || !owner_id ? null : owner_id,
                capabilities,
                is_active: req.body.is_active ? true : false,
                kind: 'COMPOSITE'
            }
        });

        await prisma.$transaction(async tx => {
            const composite = await tx.modelComposite.create({
                data: {
                    model_id: model.id,
                    strategy: strategy || 'ROUND_ROBIN',
                    members: {
                        create: members.map((m: CompositeMemberInput) => ({
                            member_model_id: m.id,
                            weight: m.weight,
                            position: m.position
                        }))
                    }
                }
            });

            if (strategy === 'PIPELINE') {
                const ordered = pipelineSteps.length > 0 ? pipelineSteps : members.map((m: CompositeMemberInput, idx: number) => ({ id: m.id, position: idx, prompt: '' }));
                await tx.modelPipelineStep.createMany({
                    data: ordered.map((step: PipelineStepInput) => ({
                        composite_id: composite.id,
                        member_model_id: step.id,
                        position: step.position,
                        prompt_template: step.prompt || null
                    }))
                });
            }

            await tx.model.update({
                where: { id: model.id },
                data: { api_model_id: model.id }
            });
        });

        await logAdminAction((req.session as any).userId, 'model.composite.create', model.id);
        res.redirect(`/admin/models?success=Composite model created&model=${model.id}`);
    } catch (e) {
        console.error(e);
        res.redirect('/admin/models?error=Failed to create composite model');
    }
};

export const updateModel = async (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = await prisma.model.findUnique({
        where: { id },
        include: { composite: { include: { members: true } } }
    });
    if (!existing) return res.redirect('/admin/models?error=Model not found');

    const baseData: any = {
        name: req.body.name || existing.name,
        description: req.body.description || null,
        owner_id: req.body.owner_id === 'system' || !req.body.owner_id ? null : req.body.owner_id,
        is_active: req.body.is_active ? true : false,
        capabilities: parseCapabilities(req.body.capabilities)
    };

    if (existing.kind === 'SINGLE') {
        if (req.body.api_provider && req.body.api_provider !== 'composite') {
            baseData.api_provider = req.body.api_provider;
        }
        if (req.body.api_model_id) {
            baseData.api_model_id = req.body.api_model_id;
        }
    }

    try {
        if (existing.kind === 'COMPOSITE') {
            const members = parseCompositeMembers(req.body);
            if (members.length < 2) {
                return res.redirect(`/admin/models?error=Select at least two member models&model=${id}`);
            }
            const strategy = req.body.strategy || 'ROUND_ROBIN';
            const pipelineSteps = parsePipelineSteps(req.body);
            if (strategy === 'PIPELINE' && pipelineSteps.length < 2) {
                return res.redirect(`/admin/models?error=Pipeline requires at least two steps&model=${id}`);
            }

            await prisma.$transaction(async tx => {
                await tx.model.update({ where: { id }, data: baseData });
                await tx.modelComposite.upsert({
                    where: { model_id: id },
                    update: { strategy },
                    create: { model_id: id, strategy }
                });
                await tx.modelCompositeMember.deleteMany({ where: { composite: { model_id: id } } });
                const composite = await tx.modelComposite.findUnique({ where: { model_id: id } });
                if (composite) {
                    await tx.modelCompositeMember.createMany({
                        data: members.map((m: CompositeMemberInput) => ({
                            composite_id: composite.id,
                            member_model_id: m.id,
                            weight: m.weight,
                            position: m.position
                        }))
                    });
                    await tx.modelPipelineStep.deleteMany({ where: { composite_id: composite.id } });
                    if (strategy === 'PIPELINE') {
                        const ordered = pipelineSteps.length > 0 ? pipelineSteps : members.map((m: CompositeMemberInput, idx: number) => ({ id: m.id, position: idx, prompt: '' }));
                        await tx.modelPipelineStep.createMany({
                            data: ordered.map((step: PipelineStepInput) => ({
                                composite_id: composite.id,
                                member_model_id: step.id,
                                position: step.position,
                                prompt_template: step.prompt || null
                            }))
                        });
                    }
                }
            });
        } else {
            await prisma.model.update({ where: { id }, data: baseData });
        }

        await logAdminAction((req.session as any).userId, 'model.update', id);
        res.redirect(`/admin/models?success=Model updated&model=${id}`);
    } catch (e) {
        console.error(e);
        res.redirect(`/admin/models?error=Failed to update model&model=${id}`);
    }
};

export const deleteModel = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await prisma.model.delete({ where: { id } });
        await logAdminAction((req.session as any).userId, 'model.delete', id);
        res.redirect('/admin/models?success=Model deleted');
    } catch (e) {
        console.error(e);
        await prisma.model.update({ where: { id }, data: { is_active: false } }).catch(() => null);
        await logAdminAction((req.session as any).userId, 'model.archive', id);
        res.redirect('/admin/models?error=Model in use; archived instead');
    }
};

export const banUser = async (req: Request, res: Response) => {
    const { id } = req.params;
    await prisma.user.update({
        where: { id },
        data: { banned: true }
    });
    await logAdminAction((req.session as any).userId, 'user.ban', id);
    res.redirect('/admin/users');
};

export const unbanUser = async (req: Request, res: Response) => {
    const { id } = req.params;
    await prisma.user.update({
        where: { id },
        data: { banned: false }
    });
    await logAdminAction((req.session as any).userId, 'user.unban', id);
    res.redirect('/admin/users');
};

// --- User Management Extended ---
export const getUserDetails = async (req: Request, res: Response) => {
    const { id } = req.params;
    const [user, plans] = await Promise.all([
        prisma.user.findUnique({
            where: { id },
            include: {
                matches: { orderBy: { created_at: 'desc' }, take: 5 },
                api_keys: { include: { scopes: true } },
                plan: true,
                _count: { select: { matches: true } }
            }
        }),
        prisma.subscriptionPlan.findMany({
            where: { is_active: true },
            orderBy: [{ level: 'asc' }, { name: 'asc' }]
        })
    ]);
    
    if (!user) return res.redirect('/admin/users');
    
    const apiKeyScopes = await apiKeyScopesForAdmin();
    res.render('admin/users/detail', { 
        title: `User: ${user.email}`, 
        path: '/admin/users', 
        user,
        plans,
        apiKeyScopes,
        success: req.query.success,
        error: req.query.error
    });
};

export const updateUserDetails = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { 
        name, company, job_title, email, role, tier, phone, plan_id,
        chat_notifications_enabled,
        chat_notifications_sound,
        chat_notifications_rate_limit,
        chat_presence_visible
    } = req.body;
    const data: any = {};

    const existing = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!existing) return res.redirect('/admin/users');

    if (name !== undefined) data.name = name || null;
    if (company !== undefined) data.company = company || null;
    if (job_title !== undefined) data.job_title = job_title || null;
    if (email !== undefined) data.email = email;
    if (phone !== undefined) data.phone = phone || null;

    if (chat_notifications_enabled !== undefined) data.chat_notifications_enabled = chat_notifications_enabled === 'on';
    if (chat_notifications_sound !== undefined) data.chat_notifications_sound = chat_notifications_sound === 'on';
    if (chat_notifications_rate_limit !== undefined) data.chat_notifications_rate_limit = parseInt(chat_notifications_rate_limit) || 0;
    if (chat_presence_visible !== undefined) data.chat_presence_visible = chat_presence_visible === 'on';

    const allowedRoles = ['USER', 'ADMIN'];
    if (role && allowedRoles.includes(role)) data.role = role;

    if (plan_id !== undefined) {
        if (plan_id) {
            const plan = await prisma.subscriptionPlan.findUnique({ where: { id: plan_id } });
            if (!plan) {
                return res.redirect(`/admin/users/${id}?error=Plan not found`);
            }
            data.plan_id = plan.id;
            data.tier = mapPlanLevelToTier(plan.level);
        } else {
            data.plan_id = null;
        }
    } else {
        const allowedTiers = ['FREE', 'PRO', 'ENTERPRISE'];
        if (tier && allowedTiers.includes(tier)) data.tier = tier;
    }

    const targetRole = data.role || existing.role;
    if (targetRole === 'ADMIN') {
        const enterprisePlan = await getEnterprisePlan();
        data.tier = 'ENTERPRISE';
        if (enterprisePlan) {
            data.plan_id = enterprisePlan.id;
        }
    }

    data.email_verified = req.body.email_verified ? true : false;
    data.banned = req.body.banned ? true : false;
    data.phone_verified = req.body.phone_verified ? true : false;

    try {
        await prisma.user.update({ where: { id }, data });
        await logAdminAction((req.session as any).userId, 'user.update', id, { fields: Object.keys(data) });
        res.redirect(`/admin/users/${id}?success=User updated`);
    } catch (e) {
        console.error(e);
        res.redirect(`/admin/users/${id}?error=Failed to update user`);
    }
};

export const createUser = async (req: Request, res: Response) => {
    const { email, password, role, tier, name, plan_id } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        const normalizedRole = role === 'ADMIN' ? 'ADMIN' : 'USER';
        let normalizedTier = normalizedRole === 'ADMIN'
            ? 'ENTERPRISE'
            : (['FREE', 'PRO', 'ENTERPRISE'].includes(tier) ? tier : 'FREE');
        let planId: string | null = null;
        if (normalizedRole === 'ADMIN') {
            const enterprisePlan = await getEnterprisePlan();
            if (enterprisePlan) {
                planId = enterprisePlan.id;
                normalizedTier = mapPlanLevelToTier(enterprisePlan.level);
            }
        } else if (plan_id) {
            const plan = await prisma.subscriptionPlan.findUnique({ where: { id: plan_id } });
            if (plan) {
                planId = plan.id;
                normalizedTier = mapPlanLevelToTier(plan.level);
            }
        }
        await prisma.user.create({
            data: {
                email,
                password_hash: hash,
                role: normalizedRole,
                tier: normalizedTier,
                plan_id: planId,
                name: name || undefined
            }
        });
        await logAdminAction((req.session as any).userId, 'user.create', email, { role: normalizedRole, tier: normalizedTier, name });
        res.redirect('/admin/users');
    } catch (e) {
        res.redirect('/admin/users?error=Failed to create user');
    }
};

export const updateUserPassword = async (req: Request, res: Response) => {
    const { id } = req.params;
    const { password } = req.body;
    
    try {
        const hash = await bcrypt.hash(password, 10);
        await prisma.user.update({
            where: { id },
            data: { password_hash: hash }
        });
        await logAdminAction((req.session as any).userId, 'user.password.reset', id);
        res.redirect(`/admin/users/${id}?success=Password updated`);
    } catch (e) {
        res.redirect(`/admin/users/${id}?error=Failed to update password`);
    }
};

export const resetUser2FA = async (req: Request, res: Response) => {
    const { id } = req.params;
    
    try {
        await prisma.user.update({
            where: { id },
            data: { 
                phone: null, 
                phone_verified: false,
                phone_verification_code: null
            }
        });
        await logAdminAction((req.session as any).userId, 'user.2fa.reset', id);
        res.redirect(`/admin/users/${id}?success=2FA reset`);
    } catch (e) {
        res.redirect(`/admin/users/${id}?error=Failed to reset 2FA`);
    }
};

export const exportUsers = async (req: Request, res: Response) => {
    const entitlements = (req as any).entitlements;
    const canExport = !entitlements?.resolved?.['export.csv'] || entitlements.hasEntitlement('export.csv');
    if (!canExport) {
        return res.status(403).send('Export not allowed for your subscription.');
    }
    const users = await prisma.user.findMany({
        orderBy: { created_at: 'desc' },
        include: { plan: true }
    });

    const workbook = createWorkbook('User Export');
    const columns = [
        { header: 'User ID', key: 'id', width: 36 },
        { header: 'Email', key: 'email', width: 28 },
        { header: 'Name', key: 'name', width: 22 },
        { header: 'Role', key: 'role', width: 12 },
        { header: 'Tier', key: 'tier', width: 14 },
        { header: 'Plan', key: 'plan', width: 18 },
        { header: 'Status', key: 'status', width: 16 },
        { header: 'Joined', key: 'joined', width: 22 }
    ];
    const sheet = createStyledSheet(workbook, 'Users', 'LLM Arena Users', columns);
    addDataRows(sheet, users.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name || '',
        role: u.role,
        tier: u.tier,
        plan: u.plan ? u.plan.name : '',
        status: u.banned ? 'BANNED' : (u.email_verified ? 'ACTIVE' : 'UNVERIFIED'),
        joined: u.created_at.toISOString()
    })));
    applyColumnSizing(sheet, columns);

    const summaryColumns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 18 }
    ];
    const summary = createStyledSheet(workbook, 'Summary', 'User Summary', summaryColumns);
    const roleCounts = users.reduce<Record<string, number>>((acc, u) => {
        acc[u.role] = (acc[u.role] || 0) + 1;
        return acc;
    }, {});
    const tierCounts = users.reduce<Record<string, number>>((acc, u) => {
        acc[u.tier] = (acc[u.tier] || 0) + 1;
        return acc;
    }, {});
    const planCounts = users.reduce<Record<string, number>>((acc, u) => {
        const key = u.plan ? u.plan.name : 'No Plan';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    addDataRows(summary, [
        { metric: 'Total users', value: users.length },
        { metric: 'Admins', value: roleCounts.ADMIN || 0 },
        { metric: 'Banned users', value: users.filter(u => u.banned).length },
        { metric: 'Verified users', value: users.filter(u => u.email_verified).length },
        ...Object.entries(tierCounts).map(([tier, count]) => ({ metric: `Tier: ${tier}`, value: count })),
        ...Object.entries(planCounts).map(([plan, count]) => ({ metric: `Plan: ${plan}`, value: count }))
    ]);
    applyColumnSizing(summary, summaryColumns);

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=\"users_export.xlsx\"');
    res.send(Buffer.from(buffer as ArrayBuffer));
};

// --- Match Management ---
export const matchList = async (req: Request, res: Response) => {
    const status = req.query.status as MatchStatus | undefined;
    const where = status ? { status } : {};
    
    const matches = await prisma.match.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: { created_by: { select: { email: true } } },
        take: 50
    });
    
    res.render('admin/matches/list', { title: 'Match Operations', path: '/admin/matches', matches, filter: status });
};

export const cancelMatch = async (req: Request, res: Response) => {
    const { id } = req.params;
    // Update DB
    await prisma.match.update({
        where: { id },
        data: { status: 'FAILED' } // Or 'CANCELLED' if we add that enum
    });
    
    // Attempt to remove from queue if waiting
    const jobs = await matchQueue.getJobs(['waiting', 'active', 'delayed']);
    const job = jobs.find(j => j.data.matchId === id);
    if (job) {
        await job.remove();
    }
    
    await logAdminAction((req.session as any).userId, 'match.cancel', id);
    res.redirect('/admin/matches');
};

export const retryMatch = async (req: Request, res: Response) => {
    const { id } = req.params;
    const match = await prisma.match.findUnique({ where: { id } });
    if (match) {
        await prisma.match.update({
            where: { id },
            data: { status: 'PENDING' }
        });
        const settings = await settingsService.getAll();
        const attempts = parseInt(settings.queue_retry_attempts || '3', 10);
        const backoffMs = parseInt(settings.queue_retry_backoff_ms || '5000', 10);
        await matchQueue.add(
            'run-match',
            { matchId: id },
            {
                attempts: Math.max(1, attempts),
                backoff: { type: 'fixed', delay: Math.max(0, backoffMs) }
            }
        );
    }
    await logAdminAction((req.session as any).userId, 'match.retry', id);
    res.redirect('/admin/matches');
};

// --- Queue Management ---
export const queueDashboard = async (req: Request, res: Response) => {
    const type = (req.query.type as any) || 'failed';
    const jobs = await matchQueue.getJobs([type], 0, 50, true); // limit 50
    const counts = await matchQueue.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed');
    
    res.render('admin/queue/index', { 
        title: 'Queue Inspector', 
        path: '/admin/queue', 
        jobs, 
        counts, 
        currentType: type 
    });
};

export const retryJob = async (req: Request, res: Response) => {
    const { id } = req.params;
    const job = await matchQueue.getJob(id);
    if (job) {
        await job.retry();
    }
    await logAdminAction((req.session as any).userId, 'queue.retry', id);
    res.redirect('/admin/queue?type=failed');
};

export const cleanQueue = async (req: Request, res: Response) => {
    await matchQueue.clean(1000, 100, 'completed');
    await matchQueue.clean(1000, 100, 'failed');
    await logAdminAction((req.session as any).userId, 'queue.clean');
    res.redirect('/admin/queue');
};

// --- Analytics ---
export const analyticsDashboard = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    
    // Fetch all data in parallel
    const [dashboard, matchesByGame, recentSignups, matchCount, userCount, modelCount] = await Promise.all([
        prisma.adminDashboard.findUnique({ where: { user_id: userId } }),
        prisma.match.groupBy({ by: ['game_type'], _count: { id: true } }),
        prisma.user.findMany({
            take: 5,
            orderBy: { created_at: 'desc' },
            select: { email: true, created_at: true }
        }),
        prisma.match.count(),
        prisma.user.count(),
        prisma.model.count()
    ]);

    const defaultLayout = [
        { id: 'matches-by-game', x: 0, y: 0, w: 6, h: 4 },
        { id: 'matches-trend', x: 6, y: 0, w: 6, h: 4 },
        { id: 'model-popularity', x: 0, y: 4, w: 4, h: 4 },
        { id: 'error-rate', x: 4, y: 4, w: 4, h: 4 },
        { id: 'recent-signups', x: 8, y: 4, w: 4, h: 4 }
    ];
    
    const layout = dashboard ? dashboard.layout : defaultLayout;

    // Calculate success rate (Mock logic for now, real implementation would group by status)
    // We'll pass raw stats to view for rendering widgets
    
    res.render('admin/analytics/index', { 
        title: 'Analytics', 
        path: '/admin/analytics',
        matchesByGame,
        recentSignups,
        stats: { matchCount, userCount, modelCount },
        layout: JSON.stringify(layout)
    });
};

export const saveAnalyticsLayout = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { layout } = req.body;
    
    await prisma.adminDashboard.upsert({
        where: { user_id: userId },
        update: { layout },
        create: { user_id: userId, layout }
    });
    
    res.json({ success: true });
};

// --- System Settings ---
export const settingsPage = async (req: Request, res: Response) => {
    const settingsMap = await settingsService.getAll();
    const content = await contentService.getAll();
    const auditLogs = await prisma.adminAuditLog.findMany({
        take: 50,
        orderBy: { created_at: 'desc' },
        include: { admin: { select: { email: true } } }
    });
    
    res.render('admin/settings/index', { 
        title: 'System Settings', 
        path: '/admin/settings',
        settings: settingsMap,
        content,
        auditLogs,
        success: req.query.success,
        error: req.query.error
    });
};

export const updateSettings = async (req: Request, res: Response) => {
    const adminId = (req.session as any).userId;
    const booleanKeys = [
        'maintenance_mode',
        'auth_require_email_verification',
        'auth_passkey_enabled',
        'auth_password_require_upper',
        'auth_password_require_lower',
        'auth_password_require_number',
        'auth_password_require_special',
        'security_hsts_enabled',
        'security_csp_allow_unsafe_eval',
        'queue_auto_clean_enabled',
        'comms_email_enabled',
        'comms_sms_enabled',
        'user_can_toggle_chat_notifications',
        'user_can_toggle_chat_sound',
        'user_can_change_chat_rate_limit',
        'user_can_toggle_chat_presence'
    ];
    const settingsKeys = [
        'global_alert',
        'auth_login_attempts',
        'auth_login_window_minutes',
        'auth_password_min_length',
        'session_idle_minutes',
        'session_remember_days',
        'limit_matches_per_day_free',
        'limit_matches_per_day_pro',
        'limit_matches_per_day_enterprise',
        'limit_api_keys_free',
        'limit_api_keys_pro',
        'limit_api_keys_enterprise',
        'limit_models_per_user_free',
        'limit_models_per_user_pro',
        'limit_models_per_user_enterprise',
        'queue_retry_attempts',
        'queue_retry_backoff_ms',
        'queue_concurrency',
        'queue_max_turns',
        'queue_auto_clean_interval_minutes',
        'security_hsts_max_age',
        'security_csp_script_src',
        'security_csp_style_src',
        'security_csp_img_src',
        'security_csp_connect_src',
        'security_csp_font_src',
        'upload_max_mb',
        'comms_email_test_address',
        'comms_sms_test_number',
        'comms_sms_provider',
        'default_user_tier'
    ];

    for (const key of booleanKeys) {
        await settingsService.update(key, req.body[key] ? 'true' : 'false');
    }

    for (const key of settingsKeys) {
        if (req.body[key] !== undefined) {
            await settingsService.update(key, String(req.body[key]));
        }
    }

    const contentKeys = [
        'public:home:hero_title',
        'public:home:hero_subtitle',
        'investor:home:hero_title',
        'investor:home:hero_text',
        'investor:press:highlight_1_date',
        'investor:press:highlight_1_title'
    ];
    for (const key of contentKeys) {
        if (req.body[key] !== undefined) {
            await contentService.update(key, String(req.body[key]));
        }
    }

    await logAdminAction(adminId, 'settings.update', undefined, { keys: Object.keys(req.body) });
    res.redirect('/admin/settings?success=Settings saved');
};

export const forceLogoutAll = async (req: Request, res: Response) => {
    const adminId = (req.session as any).userId;
    const version = Date.now().toString(36);
    await settingsService.update('session_version', version);
    await logAdminAction(adminId, 'session.force_logout_all');
    res.redirect('/admin/settings?success=All sessions invalidated');
};

export const testEmail = async (req: Request, res: Response) => {
    const adminId = (req.session as any).userId;
    const { to } = req.body;
    try {
        await comms.sendEmail(to, 'LLM Arena Test Email', 'This is a test email from the admin settings page.');
        await logAdminAction(adminId, 'comms.test_email', to);
        res.redirect('/admin/settings?success=Test email sent');
    } catch (e) {
        res.redirect('/admin/settings?error=Failed to send test email');
    }
};

export const testSms = async (req: Request, res: Response) => {
    const adminId = (req.session as any).userId;
    const { to } = req.body;
    try {
        await comms.sendSMS(to, 'LLM Arena test SMS from the admin settings page.');
        await logAdminAction(adminId, 'comms.test_sms', to);
        res.redirect('/admin/settings?success=Test SMS sent');
    } catch (e) {
        res.redirect('/admin/settings?error=Failed to send test SMS');
    }
};

export const exportAuditLogs = async (req: Request, res: Response) => {
    const entitlements = (req as any).entitlements;
    const canExport = !entitlements?.resolved?.['export.csv'] || entitlements.hasEntitlement('export.csv');
    if (!canExport) {
        return res.status(403).send('Export not allowed for your subscription.');
    }
    const logs = await prisma.adminAuditLog.findMany({
        orderBy: { created_at: 'desc' },
        take: 1000,
        include: { admin: { select: { email: true } } }
    });
    const workbook = createWorkbook('Admin Audit Log');
    const columns = [
        { header: 'Timestamp', key: 'timestamp', width: 24 },
        { header: 'Admin', key: 'admin', width: 28 },
        { header: 'Action', key: 'action', width: 24 },
        { header: 'Target', key: 'target', width: 26 },
        { header: 'Metadata', key: 'metadata', width: 60 }
    ];
    const sheet = createStyledSheet(workbook, 'Audit Log', 'Admin Audit Log', columns);
    addDataRows(sheet, logs.map(l => ({
        timestamp: l.created_at.toISOString(),
        admin: l.admin?.email || '',
        action: l.action,
        target: l.target || '',
        metadata: JSON.stringify(l.metadata || {})
    })));
    applyColumnSizing(sheet, columns);

    const summaryColumns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 18 }
    ];
    const summary = createStyledSheet(workbook, 'Summary', 'Audit Summary', summaryColumns);
    const deniedCount = logs.filter(l => l.action === 'access.denied').length;
    const actions = logs.reduce<Record<string, number>>((acc, log) => {
        acc[log.action] = (acc[log.action] || 0) + 1;
        return acc;
    }, {});
    addDataRows(summary, [
        { metric: 'Total events', value: logs.length },
        { metric: 'Denied attempts', value: deniedCount },
        ...Object.entries(actions).map(([action, count]) => ({ metric: action, value: count }))
    ]);
    applyColumnSizing(summary, summaryColumns);

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=\"admin_audit_log.xlsx\"');
    res.send(Buffer.from(buffer as ArrayBuffer));
};
