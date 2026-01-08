import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import * as mediaController from '../controllers/admin/media.controller';
import * as contentController from '../controllers/admin/content.controller';
import * as rbacController from '../controllers/admin/rbac.controller';
import * as gamesController from '../controllers/admin/games.controller';
import * as entitlementsController from '../controllers/admin/entitlements.controller';
import * as apiKeysController from '../controllers/admin/api-keys.controller';
import * as plansController from '../controllers/admin/plans.controller';
import * as hrController from '../controllers/admin/hr.controller';
import * as chatController from '../controllers/admin/chat.controller';
import * as aiChatController from '../controllers/admin/ai-chat.controller';
import { approvalsDashboard, approveRequest, denyRequest, getUserBlocks, deleteUserBlock, toggleUserBlockCapability } from '../controllers/admin/approvals.controller';
import { auditDashboard, exportAuditLogs as exportAuditLogsPage } from '../controllers/admin/audit.controller';
import { isAuthenticated } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/rbac.middleware';
import { uploadMedia } from '../middleware/upload.middleware';

const router = Router();

// Protect all routes with authenticated + admin access
router.use(isAuthenticated);
router.use(requirePermission('admin.access'));

router.get('/', requirePermission('admin.dashboard.view'), adminController.dashboard);
router.get('/users', requirePermission('admin.users.view'), adminController.userList);
router.post('/users/create', requirePermission('admin.users.edit'), adminController.createUser);
router.get('/users/export', requirePermission('admin.users.export'), adminController.exportUsers);
router.get('/users/:id', requirePermission('admin.users.view'), adminController.getUserDetails);
router.post('/users/:id/update', requirePermission('admin.users.edit'), adminController.updateUserDetails);
router.post('/users/:id/password', requirePermission('admin.users.password_reset'), adminController.updateUserPassword);
router.post('/users/:id/reset-2fa', requirePermission('admin.users.2fa_reset'), adminController.resetUser2FA);
router.post('/users/:id/ban', requirePermission('admin.users.ban'), adminController.banUser);
router.post('/users/:id/unban', requirePermission('admin.users.unban'), adminController.unbanUser);
router.get('/models', requirePermission('admin.models.view'), adminController.modelList);
router.post('/models', requirePermission('admin.models.edit'), adminController.createModel);
router.post('/models/composite', requirePermission('admin.models.edit'), adminController.createCompositeModel);
router.post('/models/:id', requirePermission('admin.models.edit'), adminController.updateModel);
router.post('/models/:id/delete', requirePermission('admin.models.edit'), adminController.deleteModel);

// Match Management
router.get('/matches', requirePermission('admin.matches.view'), adminController.matchList);
router.post('/matches/:id/cancel', requirePermission('admin.matches.cancel'), adminController.cancelMatch);
router.post('/matches/:id/retry', requirePermission('admin.matches.retry'), adminController.retryMatch);

// Queue Management
router.get('/queue', requirePermission('admin.queue.view'), adminController.queueDashboard);
router.post('/queue/clean', requirePermission('admin.queue.clean'), adminController.cleanQueue);
router.post('/queue/:id/retry', requirePermission('admin.queue.retry'), adminController.retryJob);

// Analytics
router.get('/analytics', requirePermission('admin.analytics.view'), adminController.analyticsDashboard);
router.post('/analytics/layout', requirePermission('admin.analytics.edit'), adminController.saveAnalyticsLayout);

// API Keys
router.get('/api-keys', requirePermission('admin.api_keys.view'), apiKeysController.apiKeysDashboard);
router.get('/api-keys/usage/data', requirePermission('admin.api_keys.view'), apiKeysController.apiKeyUsageData);

// Approvals & Blocks
router.get('/approvals', requirePermission('admin.approvals.view'), approvalsDashboard);
router.post('/approvals/:id/approve', requirePermission('admin.approvals.edit'), approveRequest);
router.post('/approvals/:id/deny', requirePermission('admin.approvals.edit'), denyRequest);
router.get('/approvals/blocks', requirePermission('admin.users.view'), getUserBlocks);
router.post('/approvals/blocks/delete', requirePermission('admin.users.edit'), deleteUserBlock);
router.post('/approvals/blocks/toggle-capability', requirePermission('admin.users.edit'), toggleUserBlockCapability);

// Audit Log
router.get('/audit', requirePermission('admin.audit.view'), auditDashboard);
router.get('/audit/export', requirePermission('admin.audit.export'), exportAuditLogsPage);

// System Settings
router.get('/settings', requirePermission('admin.settings.view'), adminController.settingsPage);
router.post('/settings', requirePermission('admin.settings.edit'), adminController.updateSettings);
router.post('/settings/force-logout', requirePermission('admin.settings.force_logout'), adminController.forceLogoutAll);
router.post('/settings/test-email', requirePermission('admin.comms.test'), adminController.testEmail);
router.post('/settings/test-sms', requirePermission('admin.comms.test'), adminController.testSms);
router.get('/settings/audit/export', requirePermission('admin.settings.audit_export'), adminController.exportAuditLogs);

// Media
router.get('/media', requirePermission('admin.media.view'), mediaController.mediaList);
router.post('/media/upload', requirePermission('admin.media.upload'), uploadMedia, mediaController.uploadMedia);
router.post('/media/folders', requirePermission('admin.media.upload'), mediaController.createFolder);
router.post('/media/folders/delete', requirePermission('admin.media.delete'), mediaController.deleteFolder);
router.post('/media/delete', requirePermission('admin.media.delete'), mediaController.deleteMedia);

// Content
router.get('/content', requirePermission('admin.content.view'), contentController.contentList);
router.post('/content/update', requirePermission('admin.content.edit'), contentController.updateContent);

// Games
router.get('/games', requirePermission('admin.games.view'), gamesController.listGames);
router.post('/games/new', requirePermission('admin.games.edit'), gamesController.newGameDraft);
router.get('/games/:id', requirePermission('admin.games.view'), gamesController.gameWizard);
router.post('/games/:id/save', requirePermission('admin.games.edit'), gamesController.saveGameDraft);
router.post('/games/:id/publish', requirePermission('admin.games.publish'), gamesController.publishGame);
router.post('/games/:id/engine/generate', requirePermission('admin.games.edit'), gamesController.generateGameEngine);
router.post('/games/:id/engine/publish', requirePermission('admin.games.edit'), gamesController.publishGameEngine);
router.post('/games/:id/simulate', requirePermission('admin.games.edit'), gamesController.simulateGame);
router.post('/games/:id/delete', requirePermission('admin.games.edit'), gamesController.deleteGame);

// RBAC
router.get('/rbac', requirePermission('admin.rbac.view'), rbacController.rbacDashboard);
router.post('/rbac/roles', requirePermission('admin.rbac.edit'), rbacController.createRole);
router.post('/rbac/roles/permissions/:roleId', requirePermission('admin.rbac.edit'), rbacController.updateRolePermissions);
router.post('/rbac/groups', requirePermission('admin.rbac.edit'), rbacController.createGroup);
router.post('/rbac/groups/:groupId/roles', requirePermission('admin.rbac.edit'), rbacController.updateGroupRoles);
router.post('/rbac/users/:userId/assignments', requirePermission('admin.rbac.edit'), rbacController.updateUserAssignments);
router.post('/rbac/users/:userId/overrides', requirePermission('admin.rbac.edit'), rbacController.updateUserOverrides);

// Entitlements
router.get('/entitlements', requirePermission('admin.entitlements.view'), entitlementsController.entitlementsDashboard);
router.get('/entitlements/usage', requirePermission('admin.entitlements.view'), entitlementsController.entitlementsUsageDashboard);
router.get('/entitlements/usage/data', requirePermission('admin.entitlements.view'), entitlementsController.entitlementsUsageData);
router.post('/entitlements', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlement);
router.post('/entitlements/save', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlements);
router.post('/entitlements/:id/update', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlementDetails);
router.post('/entitlements/:id/policy', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlementPolicy);
router.post('/entitlements/:id/overrides', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlementOverride);
router.post('/entitlements/overrides/:id/delete', requirePermission('admin.entitlements.edit'), entitlementsController.deleteEntitlementOverride);
router.post('/entitlements/:id/delete', requirePermission('admin.entitlements.edit'), entitlementsController.deleteEntitlement);
router.post('/entitlements/categories', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlementCategory);

// API Keys
router.post('/api-keys/:id/update', requirePermission('admin.api_keys.edit'), apiKeysController.updateApiKey);
router.post('/api-keys/:id/revoke', requirePermission('admin.api_keys.revoke'), apiKeysController.revokeApiKey);

// Plans
router.get('/plans', requirePermission('admin.plans.view'), plansController.plansDashboard);
router.post('/plans', requirePermission('admin.plans.edit'), plansController.createPlan);
router.post('/plans/:id/update', requirePermission('admin.plans.edit'), plansController.updatePlan);
router.post('/plans/:id/delete', requirePermission('admin.plans.edit'), plansController.deletePlan);
router.post('/plans/:id/stripe/product', requirePermission('admin.plans.edit'), plansController.updateStripeProduct);
router.post('/plans/:id/stripe/prices', requirePermission('admin.plans.edit'), plansController.addStripePrice);
router.post('/plans/:id/stripe/prices/:priceId/update', requirePermission('admin.plans.edit'), plansController.updateStripePrice);
router.post('/plans/stripe/validate', requirePermission('admin.plans.edit'), plansController.validateStripeId);
router.post('/plans/:id/stripe/create-product-price', requirePermission('admin.plans.edit'), plansController.createStripeProductAndPrice);
router.post('/plans/:id/stripe/create-price', requirePermission('admin.plans.edit'), plansController.createStripePrice);
router.post('/plans/:id/stripe/sync', requirePermission('admin.plans.edit'), plansController.syncStripePlan);

router.get('/hr', requirePermission('admin.hr.view'), hrController.hrDashboard);
router.get('/hr/jobs', requirePermission('admin.hr.view'), hrController.jobsList);
router.get('/hr/jobs/new', requirePermission('admin.hr.edit'), hrController.newJobPage);
router.post('/hr/jobs', requirePermission('admin.hr.edit'), hrController.createJob);
router.get('/hr/jobs/:id/edit', requirePermission('admin.hr.edit'), hrController.editJobPage);
router.post('/hr/jobs/:id/update', requirePermission('admin.hr.edit'), hrController.updateJob);
router.post('/hr/jobs/:id/compile', requirePermission('admin.hr.edit'), hrController.compileResumes);
router.get('/hr/applications', requirePermission('admin.hr.view'), hrController.applicationsList);
router.get('/hr/applications/:id', requirePermission('admin.hr.view'), hrController.applicationDetail);
router.post('/hr/applications/:id/status', requirePermission('admin.hr.edit'), hrController.updateApplicationStatus);
router.post('/hr/applications/:id/review', requirePermission('admin.hr.edit'), hrController.updateApplicationReview);
router.post('/hr/applications/:id/schedule', requirePermission('admin.hr.edit'), hrController.scheduleInterview);
router.post('/hr/applications/bulk', requirePermission('admin.hr.edit'), hrController.bulkUpdateApplications);

// Chat
router.get('/chat', requirePermission('admin.chat.manage'), chatController.index);
router.post('/chat/channels', requirePermission('admin.chat.manage'), chatController.createChannel);
router.post('/chat/channels/:id/delete', requirePermission('admin.chat.manage'), chatController.deleteChannel);
router.post('/chat/settings', requirePermission('admin.chat.manage'), chatController.updateGlobalSettings);
router.post('/chat/broadcast', requirePermission('admin.chat.broadcast'), chatController.broadcastAlert);
router.get('/chat/channels/:id/config', requirePermission('admin.chat.manage'), chatController.configureChannelPage);
router.post('/chat/channels/:id/config', requirePermission('admin.chat.manage'), chatController.updateChannelConfig);

// AI Chat
router.get('/ai-chat', requirePermission('admin.ai_chat.access'), aiChatController.index);
router.post('/ai-chat', requirePermission('admin.ai_chat.access'), aiChatController.createChat);
router.get('/ai-chat/:id', requirePermission('admin.ai_chat.access'), aiChatController.getChatHistory);
router.post('/ai-chat/:id/rename', requirePermission('admin.ai_chat.access'), aiChatController.renameChat);
router.post('/ai-chat/:id/delete', requirePermission('admin.ai_chat.access'), aiChatController.deleteChat);
router.get('/ai-chat/models/:provider', requirePermission('admin.ai_chat.access'), aiChatController.getModels);
router.post('/ai-chat/query', requirePermission('admin.ai_chat.query'), aiChatController.query);
router.post('/ai-chat/export', requirePermission('admin.ai_chat.export'), aiChatController.exportChat);

export default router;