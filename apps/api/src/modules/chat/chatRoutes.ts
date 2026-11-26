import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { ChatController } from './chatController';

const router = Router({ mergeParams: true });

router.get('/', authenticateGuest, ChatController.getMessages);
router.post('/', authenticateGuest, ChatController.sendMessage);
router.patch('/settings', authenticateGuest, ChatController.updateSettings);
router.delete('/:messageId', authenticateGuest, ChatController.deleteMessage);
router.post('/participants/:participantId/mute', authenticateGuest, ChatController.muteParticipant);

export default router;
