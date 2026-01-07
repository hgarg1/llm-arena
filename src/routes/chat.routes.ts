import { Router } from 'express';
import * as chatController from '../controllers/chat.controller';
import { isAuthenticated } from '../middleware/auth.middleware';

const router = Router();

router.use(isAuthenticated);

router.get('/', chatController.index);
router.post('/channels', chatController.createChannel);
router.get('/channels/:id', chatController.getChannel);
router.post('/channels/:id/join', chatController.joinChannel);
router.post('/channels/:id/messages', chatController.postMessage);
router.get('/notifications/poll', chatController.pollNotifications);

export default router;
