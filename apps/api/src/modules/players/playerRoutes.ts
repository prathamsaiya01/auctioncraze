import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { PlayerController } from './playerController';

const router = Router();

router.get('/catalog', PlayerController.listCatalog);
router.get('/import/batches', PlayerController.listImportBatches);
router.post('/import/preview', authenticateGuest, PlayerController.previewImport);
router.post('/import/commit', authenticateGuest, PlayerController.commitImport);
router.post('/import/batches/:batchId/rollback', authenticateGuest, PlayerController.rollbackImportBatch);
router.get('/:id/profile', PlayerController.getProfile);

export default router;
