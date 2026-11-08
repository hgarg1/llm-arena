import Redis from 'ioredis';
import { getEnv, isRedisRuntimeEnabled } from './runtime';

type ScanResult = [string, string[]];

class InMemoryRedisFallback {
  private store = new Map<string, number>();
  private expirations = new Map<string, number>();

  private cleanup(key: string) {
    const expiresAt = this.expirations.get(key);
    if (expiresAt && expiresAt <= Date.now()) {
      this.store.delete(key);
      this.expirations.delete(key);
    }
  }

  async incr(key: string) {
    this.cleanup(key);
    const nextValue = (this.store.get(key) || 0) + 1;
    this.store.set(key, nextValue);
    return nextValue;
  }

  async expire(key: string, seconds: number) {
    this.expirations.set(key, Date.now() + Math.max(0, seconds) * 1000);
    return 1;
  }

  async scan(cursor: string, ..._args: unknown[]): Promise<ScanResult> {
    return [cursor === '0' ? '0' : '0', []];
  }

  on(_event: string, _handler: (...args: unknown[]) => void) {
    return this;
  }
}

const createRedisClient = () => {
  if (!isRedisRuntimeEnabled()) {
    return new InMemoryRedisFallback();
  }

  const client = new Redis(getEnv('REDIS_URL'), {
    maxRetriesPerRequest: null
  });

  client.on('connect', () => {
    console.log('Redis connected');
  });

  client.on('error', err => {
    console.error('Redis connection error:', err);
  });

  return client;
};

export const redisConnection: any = createRedisClient();
export const redisSubscriber: any = createRedisClient();
