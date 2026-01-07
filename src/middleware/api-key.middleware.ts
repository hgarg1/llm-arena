import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/db';

const hashKey = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');

const extractKey = (req: Request) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  if (Array.isArray(apiKey)) return apiKey[0];
  return apiKey ? String(apiKey) : '';
};

export const apiKeyAuthOptional = async (req: Request, res: Response, next: NextFunction) => {
  const rawKey = extractKey(req);
  if (!rawKey) return next();

  const keyHash = hashKey(rawKey);
  const apiKey = await prisma.apiKey.findUnique({
    where: { key_hash: keyHash },
    include: { scopes: true, user: { select: { id: true, email: true, role: true } } }
  });
  if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });
  if (apiKey.status !== 'ACTIVE') return res.status(403).json({ error: 'API key inactive' });
  if (apiKey.expires_at && apiKey.expires_at < new Date()) {
    return res.status(403).json({ error: 'API key expired' });
  }

  (req as any).apiKey = apiKey;
  return next();
};

export const requireApiScope = (scope: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = (req as any).apiKey as { scopes: { scope_key: string }[] } | undefined;
    if (!apiKey) return next();
    if (!apiKey.scopes || apiKey.scopes.length === 0) return next();
    const allowed = apiKey.scopes.some(s => s.scope_key === scope);
    if (!allowed) return res.status(403).json({ error: 'Insufficient scope' });
    return next();
  };
};

export const apiKeyUsageTracker = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = (req as any).apiKey as { id: string } | undefined;
  if (!apiKey) return next();

  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0);
  const route = req.route?.path ? String(req.route.path) : req.path;
  const method = req.method.toUpperCase();

  res.on('finish', async () => {
    try {
      await prisma.apiKeyUsage.upsert({
        where: {
          key_id_route_method_status_code_window_start: {
            key_id: apiKey.id,
            route,
            method,
            status_code: res.statusCode,
            window_start: windowStart
          }
        },
        update: { count: { increment: 1 } },
        create: {
          key_id: apiKey.id,
          route,
          method,
          status_code: res.statusCode,
          window_start: windowStart,
          count: 1
        }
      });
      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { last_used: new Date() }
      });
    } catch (err) {
      console.error('Failed to record API key usage', err);
    }
  });

  return next();
};
