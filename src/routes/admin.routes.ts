import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import * as mediaController from '../controllers/admin/media.controller';
import * as contentController from '../controllers/admin/content.controller';
import * as rbacController from '../controllers/admin/rbac.controller';
import * as gamesController from '../controllers/admin/games.controller';
import * as entitlementsController from '../controllers/admin/entitlements.controller';
import * as plansController from '../controllers/admin/plans.controller';
import { approvalsDashboard, approveRequest, denyRequest } from '../controllers/admin/approvals.controller';
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

// Approvals
router.get('/approvals', requirePermission('admin.approvals.view'), approvalsDashboard);
router.post('/approvals/:id/approve', requirePermission('admin.approvals.edit'), approveRequest);
router.post('/approvals/:id/deny', requirePermission('admin.approvals.edit'), denyRequest);

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

// ... existing routes ...

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
router.post('/entitlements', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlement);
router.post('/entitlements/save', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlements);
router.post('/entitlements/:id/update', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlementDetails);
router.post('/entitlements/:id/policy', requirePermission('admin.entitlements.edit'), entitlementsController.updateEntitlementPolicy);
router.post('/entitlements/:id/overrides', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlementOverride);
router.post('/entitlements/overrides/:id/delete', requirePermission('admin.entitlements.edit'), entitlementsController.deleteEntitlementOverride);
router.post('/entitlements/:id/delete', requirePermission('admin.entitlements.edit'), entitlementsController.deleteEntitlement);
router.post('/entitlements/categories', requirePermission('admin.entitlements.edit'), entitlementsController.createEntitlementCategory);

// Plans
router.get('/plans', requirePermission('admin.plans.view'), plansController.plansDashboard);
router.post('/plans', requirePermission('admin.plans.edit'), plansController.createPlan);
router.post('/plans/:id/update', requirePermission('admin.plans.edit'), plansController.updatePlan);
router.post('/plans/:id/delete', requirePermission('admin.plans.edit'), plansController.deletePlan);

export default router;
