import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request, Response, NextFunction } from 'express';
import { scanFileWithClamAV } from '../services/clamav.service';

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only images are allowed'));
  }
};

const sanitizeSubdir = (value?: string) => {
  if (!value) return '';
  const cleaned = value.replace(/\\/g, '/').replace(/^\//, '');
  if (cleaned.includes('..')) return '';
  return cleaned.replace(/\/+/g, '/').replace(/\/$/, '');
};

const redirectUploadError = (req: Request, res: Response, message: string) => {
  const encoded = encodeURIComponent(message);
  if (req.originalUrl.startsWith('/admin/media')) {
    return res.redirect(`/admin/media?error=${encoded}`);
  }
  if (req.originalUrl.startsWith('/account')) {
    return res.redirect(`/account?error=${encoded}`);
  }
  return res.status(400).send(message);
};

const createUpload = (destDir: string, prefix: string, fieldName: string, resolveSubdir?: (req: Request) => string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const settings = res.locals.settings || {};
    const maxMb = parseInt(settings.upload_max_mb || '5', 10);
    const storage = multer.diskStorage({
      destination: function (req, file, cb) {
        const subdir = resolveSubdir ? sanitizeSubdir(resolveSubdir(req)) : '';
        const finalDir = subdir ? path.join(destDir, subdir) : destDir;
        ensureDir(finalDir);
        cb(null, finalDir);
      },
      filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
      }
    });

    const upload = multer({
      storage,
      fileFilter,
      limits: { fileSize: Math.max(1, maxMb) * 1024 * 1024 }
    }).single(fieldName);

    upload(req, res, async (err: any) => {
      if (err) {
        return redirectUploadError(req, res, err.message || 'Upload failed');
      }
      if (req.file) {
        try {
          const scanResult = await scanFileWithClamAV(req.file.path);
          if (!scanResult.clean) {
            try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
            return redirectUploadError(req, res, 'Upload blocked: malware detected.');
          }
        } catch (scanErr: any) {
          try { fs.unlinkSync(req.file.path); } catch { /* noop */ }
          return redirectUploadError(req, res, scanErr?.message || 'Upload blocked: malware scan failed.');
        }
      }
      return next();
    });
  };
};

export const uploadAvatar = createUpload(path.join(__dirname, '../../public/uploads/avatars'), 'avatar', 'avatar');
export const uploadMedia = createUpload(
  path.join(__dirname, '../../public/img'),
  'media',
  'file',
  (req) => String((req.body as any)?.folder || '')
);
