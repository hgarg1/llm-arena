import { Router } from 'express';
import * as chatController from '../controllers/chat.controller';
import { isAuthenticated } from '../middleware/auth.middleware';
import { uploadChatFiles } from '../middleware/upload.middleware';

const router = Router();

router.use(isAuthenticated);

router.get('/', chatController.index);
router.get('/candidates', chatController.searchCandidates);
router.post('/channels', chatController.createChannel);
router.post('/dm', chatController.startDM);
router.post('/block', chatController.blockUser);
router.post('/unblock', chatController.unblockUser);

router.get('/channels/:id', chatController.getChannel);
router.post('/channels/:id/join', chatController.joinChannel);
// Use uploadChatFiles middleware which handles multiple file scanning and storage
router.post('/channels/:id/messages', uploadChatFiles, chatController.postMessage);
router.put('/channels/:id/messages/:messageId', chatController.editMessage);
router.delete('/channels/:id/messages/:messageId', chatController.deleteMessage);

router.get('/notifications/poll', chatController.pollNotifications);

export default router;