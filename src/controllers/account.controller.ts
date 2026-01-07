import { Request, Response } from 'express';
import { prisma } from '../config/db';
import bcrypt from 'bcrypt';
import { comms } from '../services/communication';
import { mfaService } from '../services/mfa.service';
import crypto from 'crypto';

const mapPlanLevelToTier = (level: number) => {
    if (level >= 3) return 'ENTERPRISE';
    if (level >= 2) return 'PRO';
    return 'FREE';
};

const findPlanForTier = (plans: Array<{ id: string; level: number; name: string }>, tier: string | null | undefined) => {
    if (!tier) return null;
    if (tier === 'ENTERPRISE') {
        return plans.filter(plan => plan.level >= 3).sort((a, b) => b.level - a.level)[0] || null;
    }
    if (tier === 'PRO') {
        return plans.filter(plan => plan.level >= 2 && plan.level < 3).sort((a, b) => b.level - a.level)[0] || null;
    }
    return plans.filter(plan => plan.level <= 1).sort((a, b) => b.level - a.level)[0] || null;
};

// ... existing methods ...

export const setupMfaPage = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.redirect('/auth/login');

    // Generate temporary secret for setup session
    const { secret, otpauth } = mfaService.generateSecret(user.email);
    const qrCode = await mfaService.generateQRCode(otpauth);

    // Store secret in session temporarily until verified
    (req.session as any).tempMfaSecret = secret;

    res.render('account/mfa-setup', { 
        title: 'Setup 2FA', 
        path: '/account', 
        qrCode, 
        secret, 
        step: 1,
        error: null 
    });
};

export const verifyMfaSetup = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { token } = req.body;
    const secret = (req.session as any).tempMfaSecret;

    if (!secret) return res.redirect('/account/mfa/setup');

    const isValid = mfaService.verifyToken(token, secret);

    if (isValid) {
        const backupCodes = mfaService.generateBackupCodes();
        await prisma.user.update({
            where: { id: userId },
            data: { 
                mfa_secret: secret, 
                mfa_enabled: true,
                mfa_backup_codes: backupCodes
            }
        });
        delete (req.session as any).tempMfaSecret;
        
        // Render success/backup codes view
        return res.render('account/mfa-setup', { 
            title: '2FA Activated', 
            path: '/account', 
            step: 2, 
            backupCodes,
            error: null
        });
    } else {
        // Re-render step 1 with error
        // We need to re-generate QR or persist it. 
        // For MVP, redirect to start is safer/easier, or re-generate.
        return res.redirect('/account/mfa/setup?error=Invalid Code');
    }
};

export const disableMfa = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    await prisma.user.update({
        where: { id: userId },
        data: { mfa_enabled: false, mfa_secret: null, mfa_backup_codes: [] }
    });
    res.redirect('/account?success=2FA Disabled');
};

export const settingsPage = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    if (!userId) return res.redirect('/auth/login');

    const [user, plans] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            include: {
                matches: { orderBy: { created_at: 'desc' }, take: 10 },
                api_keys: { orderBy: { created_at: 'desc' } },
                passkeys: { orderBy: { created_at: 'desc' } },
                plan: true
            }
        }),
        prisma.subscriptionPlan.findMany({
            where: { is_active: true },
            orderBy: [{ level: 'asc' }, { name: 'asc' }]
        })
    ]);
    if (!user) return res.redirect('/auth/login');

    const currentPlan = user.plan || findPlanForTier(plans, user.tier);
    const currentPlanLevel = currentPlan ? currentPlan.level : 1;

    res.render('account/settings', { 
        title: 'Account Settings', 
        path: '/account', 
        user,
        plans,
        currentPlanId: currentPlan ? currentPlan.id : null,
        currentPlanName: currentPlan ? currentPlan.name : null,
        currentPlanLevel,
        success: req.query.success,
        error: req.query.error,
        newApiKey: null
    });
};

export const updateProfile = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { name, company, job_title } = req.body;
    
    const data: any = { name, company, job_title };

    if (req.file) {
        // Store relative path for public access
        data.avatar_url = '/uploads/avatars/' + req.file.filename;
    }

    try {
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data
        });
        
        // Update session
        if ((req.session as any).user) {
            (req.session as any).user.name = updatedUser.name;
            (req.session as any).user.avatar_url = updatedUser.avatar_url;
        }

        res.redirect('/account?success=Profile updated successfully');
    } catch (e) {
        console.error(e);
        res.redirect('/account?error=Failed to update profile');
    }
};

export const upgradeTier = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true, plan_id: true, email_verified: true } });
    if (!user) return res.redirect('/auth/login');

    const { tier, plan_id } = req.body;
    const currentPlan = user.plan_id ? await prisma.subscriptionPlan.findUnique({ where: { id: user.plan_id } }) : null;
    const currentLevel = currentPlan ? currentPlan.level : (user.tier === 'ENTERPRISE' ? 3 : user.tier === 'PRO' ? 2 : 1);

    try {
        if (plan_id) {
            const plan = await prisma.subscriptionPlan.findUnique({ where: { id: plan_id } });
            if (!plan || !plan.is_active) {
                return res.redirect('/account?error=Plan not found');
            }
            if (!user.email_verified && plan.level > currentLevel) {
                return res.redirect('/account?error=Please verify your email before upgrading.');
            }
            const newTier = mapPlanLevelToTier(plan.level);
            await prisma.user.update({
                where: { id: userId },
                data: { tier: newTier, plan_id: plan.id }
            });
            if ((req.session as any).user) {
                (req.session as any).user.tier = newTier;
                (req.session as any).user.plan_id = plan.id;
            }
        } else if (tier) {
            const tierRank = (value: string) => (value === 'ENTERPRISE' ? 3 : value === 'PRO' ? 2 : 1);
            if (!user.email_verified && tierRank(tier) > currentLevel) {
                return res.redirect('/account?error=Please verify your email before upgrading.');
            }
            await prisma.user.update({
                where: { id: userId },
                data: { tier: tier }
            });
            if ((req.session as any).user) {
                (req.session as any).user.tier = tier;
            }
        }
        
        res.redirect('/account?success=Plan upgraded successfully');
    } catch (e) {
        res.redirect('/account?error=Upgrade failed');
    }
};

export const changePassword = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { currentPassword, newPassword } = req.body;
    const settings = res.locals.settings || {};

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.password_hash) return res.redirect('/account?error=User not found');

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.redirect('/account?error=Incorrect current password');

    const minLen = parseInt(settings.auth_password_min_length || '12', 10);
    const requireUpper = settings.auth_password_require_upper !== 'false';
    const requireLower = settings.auth_password_require_lower !== 'false';
    const requireNumber = settings.auth_password_require_number !== 'false';
    const requireSpecial = settings.auth_password_require_special !== 'false';
    const errors = [];
    if ((newPassword || '').length < minLen) errors.push(`at least ${minLen} characters`);
    if (requireUpper && !/[A-Z]/.test(newPassword || '')) errors.push('an uppercase letter');
    if (requireLower && !/[a-z]/.test(newPassword || '')) errors.push('a lowercase letter');
    if (requireNumber && !/[0-9]/.test(newPassword || '')) errors.push('a number');
    if (requireSpecial && !/[^A-Za-z0-9]/.test(newPassword || '')) errors.push('a special character');
    if (errors.length > 0) {
        return res.redirect('/account?error=Password must include ' + errors.join(', '));
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
        where: { id: userId },
        data: { password_hash: hash }
    });

    res.redirect('/account?success=Password changed successfully');
};

export const deleteAccount = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { confirmation } = req.body;

    if (confirmation !== 'DELETE') {
        return res.redirect('/account?error=Confirmation phrase incorrect');
    }

    try {
        // Delete user (cascade or set null? Prisma defaults usually cascade but let's be safe)
        // We set models owner to null or delete? Let's just delete user.
        await prisma.user.delete({ where: { id: userId } });
        req.session.destroy(() => res.redirect('/'));
    } catch (e) {
        res.redirect('/account?error=Failed to delete account');
    }
};

export const verifyAccount = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (user && !user.email_verified) {
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.user.update({
            where: { id: userId },
            data: { email_verification_token: token }
        });
        
        const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/auth/verify-email/${token}`;
        await comms.sendEmail(user.email, 'Verify your email', `Please verify your email: ${verifyLink}`);
        
        console.log(`[MOCK EMAIL] Verification for ${user.email}: ${verifyLink}`);
        res.redirect('/account?success=Verification email sent');
    } else {
        res.redirect('/account');
    }
};

export const createApiKey = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { name } = req.body;
    const settings = res.locals.settings || {};
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tier: true } });
    const tier = user?.tier || 'FREE';
    const limitMap: Record<string, string> = {
        FREE: settings.limit_api_keys_free,
        PRO: settings.limit_api_keys_pro,
        ENTERPRISE: settings.limit_api_keys_enterprise
    };
    const limit = parseInt(limitMap[tier] || '0', 10);
    if (limit > 0) {
        const count = await prisma.apiKey.count({ where: { user_id: userId } });
        if (count >= limit) {
            return res.redirect('/account?error=API key limit reached for your plan');
        }
    }
    
    const rawKey = 'sk-' + crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    try {
        await prisma.apiKey.create({
            data: {
                name: name || 'Default Key',
                key_hash: hash,
                user_id: userId
            }
        });
        // Flash the raw key one time only
        // Since we are redirecting, we need a way to show it.
        // We'll pass it in query param (not secure for prod, use flash session) 
        // or render a success page.
        // For MVP, passing in URL query param with a warning.
        // Better: render the settings page directly with the new key.
        
        const [user, plans] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                include: {
                    matches: { orderBy: { created_at: 'desc' }, take: 10 },
                    api_keys: { orderBy: { created_at: 'desc' } },
                    passkeys: { orderBy: { created_at: 'desc' } },
                    plan: true
                }
            }),
            prisma.subscriptionPlan.findMany({
                where: { is_active: true },
                orderBy: [{ level: 'asc' }, { name: 'asc' }]
            })
        ]);
        const currentPlan = user?.plan || findPlanForTier(plans, user?.tier);
        const currentPlanLevel = currentPlan ? currentPlan.level : 1;
        
        res.render('account/settings', { 
            title: 'Account Settings', 
            path: '/account', 
            user,
            plans,
            currentPlanId: currentPlan ? currentPlan.id : null,
            currentPlanName: currentPlan ? currentPlan.name : null,
            currentPlanLevel,
            success: 'API Key created',
            newApiKey: rawKey,
            error: null
        });

    } catch (e) {
        res.redirect('/account?error=Failed to create API key');
    }
};

export const deleteApiKey = async (req: Request, res: Response) => {
    const userId = (req.session as any).userId;
    const { id } = req.body;

    try {
        // Ensure user owns key
        const key = await prisma.apiKey.findFirst({ where: { id, user_id: userId } });
        if (key) {
            await prisma.apiKey.delete({ where: { id } });
            res.redirect('/account?success=API Key deleted');
        } else {
            res.redirect('/account?error=Key not found');
        }
    } catch (e) {
        res.redirect('/account?error=Failed to delete key');
    }
};
