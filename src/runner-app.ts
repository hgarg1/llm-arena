import express from 'express';
import { acceptSlice } from './services/runner/slice-handler';
import { sweepMatches } from './services/runner/sweeper';
import { verifyCronRequest, verifyRunnerRequest } from './services/runner/auth';
import { logMetric } from './services/metrics.service';

/**
 * The internal API that runs matches. It is deliberately a separate Express app (and a separate Vercel
 * function, see api/internal.js) from the website, so page traffic and match execution scale, time out
 * and fail independently. No session, CSRF or cookies: every call is authenticated with a signed header
 * or the cron secret, and fails closed when no secret is configured.
 */
export const createRunnerApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.post('/api/internal/match-slice', async (req, res) => {
    const matchId = typeof req.body?.matchId === 'string' ? req.body.matchId : '';
    if (!verifyRunnerRequest(req.headers, matchId)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await acceptSlice(req.body);
      return res.status(result.status).json(result.body);
    } catch (err: any) {
      console.error('match-slice failed:', err);
      return res.status(500).json({ error: 'Slice could not be started' });
    }
  });

  app.all('/api/internal/sweep', async (req, res) => {
    if (!verifyCronRequest(req.headers) && !verifyRunnerRequest(req.headers, 'sweep')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await sweepMatches();
      logMetric('runner.sweep', { ...result });
      return res.json(result);
    } catch (err: any) {
      console.error('sweep failed:', err);
      return res.status(500).json({ error: 'Sweep failed' });
    }
  });

  return app;
};
