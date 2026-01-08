import { Router } from 'express';
import * as gamesController from '../controllers/api/games.controller';
import { apiKeyAuthOptional, apiKeyUsageTracker, requireApiScope } from '../middleware/api-key.middleware';
import { apiRateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/games/:gameId/simulate', 
    apiKeyAuthOptional,
    apiRateLimit,
    requireApiScope('games.simulate'), 
    apiKeyUsageTracker, 
    gamesController.simulate
);

export default router;
