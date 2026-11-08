import session from 'express-session';
import { prisma } from './db';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Roughly one write in fifty also clears expired rows, so the table cannot grow without bound. */
const PRUNE_PROBABILITY = 0.02;

type Callback<T = void> = (err?: unknown, result?: T) => void;

/**
 * express-session store backed by the application database (table `HttpSession`).
 *
 * Note that express-session sends the last byte of every response only after the session has been saved to the
 * store, so a store that hangs makes every page stall one byte short. This store therefore relies on the database
 * client's own timeouts and never swallows errors.
 */
export class PrismaSessionStore extends session.Store {
  constructor(private readonly ttlMs = DEFAULT_TTL_MS, private readonly random: () => number = Math.random) {
    super();
  }

  private expiryOf(sess: session.SessionData): Date {
    const expires = sess?.cookie?.expires;
    const date = expires ? new Date(expires as unknown as string) : null;
    return date && !Number.isNaN(date.getTime()) ? date : new Date(Date.now() + this.ttlMs);
  }

  get = (sid: string, cb: Callback<session.SessionData | null>) => {
    prisma.httpSession.findUnique({ where: { sid } })
      .then(async row => {
        if (!row) return cb(null, null);
        if (row.expire.getTime() <= Date.now()) {
          await prisma.httpSession.deleteMany({ where: { sid } }).catch(() => undefined);
          return cb(null, null);
        }
        return cb(null, row.sess as unknown as session.SessionData);
      })
      .catch(err => cb(err));
  };

  set = (sid: string, sess: session.SessionData, cb?: Callback) => {
    const expire = this.expiryOf(sess);
    const data = JSON.parse(JSON.stringify(sess));
    prisma.httpSession.upsert({
      where: { sid },
      update: { sess: data, expire },
      create: { sid, sess: data, expire }
    })
      .then(() => {
        if (this.random() < PRUNE_PROBABILITY) {
          void prisma.httpSession.deleteMany({ where: { expire: { lt: new Date() } } }).catch(() => undefined);
        }
        cb?.();
      })
      .catch(err => cb?.(err));
  };

  destroy = (sid: string, cb?: Callback) => {
    prisma.httpSession.deleteMany({ where: { sid } })
      .then(() => cb?.())
      .catch(err => cb?.(err));
  };

  /** Extends the lifetime without rewriting the data (rolling sessions). */
  touch = (sid: string, sess: session.SessionData, cb?: Callback) => {
    prisma.httpSession.updateMany({ where: { sid }, data: { expire: this.expiryOf(sess) } })
      .then(() => cb?.())
      .catch(err => cb?.(err));
  };
}
