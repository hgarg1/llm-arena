import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export const matchQueue = new Queue('match-queue', {
  connection: redisConnection as any,
});
