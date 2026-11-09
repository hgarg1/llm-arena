import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';
import { isQueueEnabled } from '../config/runtime';

const disabledQueue = {
  async add(_name: string, data: any) {
    return { id: 'queue-disabled', data };
  },
  async getJobCounts(..._statuses: string[]) {
    return {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0
    };
  },
  async getJobs(..._args: any[]) {
    return [];
  },
  async getJob(_id: string) {
    return null;
  },
  async clean(..._args: any[]) {
    return [];
  }
};

let queueInstance: Queue | null = null;

const getQueue = () => {
  if (!isQueueEnabled()) {
    return disabledQueue;
  }

  if (!queueInstance) {
    queueInstance = new Queue('match-queue', {
      connection: redisConnection as any
    });
  }

  return queueInstance;
};

export const matchQueue = {
  add(...args: Parameters<Queue['add']>) {
    return (getQueue() as any).add(...args);
  },
  getJobCounts(...args: any[]) {
    return (getQueue() as any).getJobCounts(...args);
  },
  getJobs(...args: any[]) {
    return (getQueue() as any).getJobs(...args);
  },
  getJob(...args: any[]) {
    return (getQueue() as any).getJob(...args);
  },
  clean(...args: any[]) {
    return (getQueue() as any).clean(...args);
  }
};
