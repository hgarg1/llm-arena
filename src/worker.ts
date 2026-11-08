import { Worker } from 'bullmq';
import { redisConnection } from './config/redis';
import { settingsService } from './services/settings.service';
import { matchQueue } from './services/queue';
import { runMatch } from './services/match-runner.service';
import { buildRunnerDeps } from './services/runner/default-deps';

const startWorker = async () => {
  const settings = await settingsService.getAll();
  const concurrency = Math.max(1, parseInt(settings.queue_concurrency || '2', 10));

  const worker = new Worker('match-queue', async job => {
    console.log(`Processing match ${job.data.matchId}`);
    await runMatch(job.data.matchId, job.data.options, await buildRunnerDeps());
    console.log(`Match ${job.data.matchId} finished.`);
  }, { connection: redisConnection as any, concurrency });

  worker.on('completed', job => {
    console.log(`Job ${job.id} has completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`Job ${job?.id} has failed with ${err.message}`);
  });

  if (settings.queue_auto_clean_enabled === 'true') {
    const intervalMinutes = Math.max(1, parseInt(settings.queue_auto_clean_interval_minutes || '60', 10));
    setInterval(async () => {
      try {
        await matchQueue.clean(1000, 100, 'completed');
        await matchQueue.clean(1000, 100, 'failed');
      } catch (err) {
        console.error('Queue clean failed:', err);
      }
    }, intervalMinutes * 60 * 1000);
  }

  console.log('Worker started...');
};

startWorker().catch(err => {
  console.error('Worker failed to start:', err);
});
