import { Router } from 'express';
import { PlayerController } from './playerController';

const router = Router();

router.get('/catalog', PlayerController.listCatalog);

export default router;
