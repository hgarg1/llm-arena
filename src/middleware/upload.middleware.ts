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
  // Allow images, PDFs, text, zip
  const allowed = ['image/', 'application/pdf', 'text/', 'application/zip', 'application/x-zip-compressed'];
  if (allowed.some(t => file.mimetype.startsWith(t))) {
    cb(null, true);
  } else {
    cb(null, false); // Skip file instead of erroring whole batch? Multer doesn't support skip easily without error.
    // For now, allow common types.
    cb(null, true); 
  }
};

const sanitizeSubdir = (value?: string) => {
  if (!value) return '';
  const cleaned = value.replace(/\\/g, '/').replace(/^\//, '');
  if (cleaned.includes('..')) return '';
  return cleaned.replace(/\/+/g, '/').replace(/\/$/, '');
};

const redirectUploadError = (req: Request, res: Response, message: string) => {
  if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(400).json({ success: false, message });
  }
  const encoded = encodeURIComponent(message);
  if (req.originalUrl.startsWith('/admin/media')) {
    return res.redirect(`/admin/media?error=${encoded}`);
  }
  if (req.originalUrl.startsWith('/account')) {
    return res.redirect(`/account?error=${encoded}`);
  }
  return res.status(400).send(message);
};

const createUpload = (destDir: string, prefix: string, fieldName: string, isArray = false, resolveSubdir?: (req: Request) => string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const settings = res.locals.settings || {};
    const maxMb = parseInt(settings.upload_max_mb || '10', 10);
    const maxFiles = parseInt(settings.chat_max_upload_count || '5', 10);

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

    const multerInstance = multer({
      storage,
      limits: { fileSize: Math.max(1, maxMb) * 1024 * 1024 }
    });

    const upload = isArray ? multerInstance.array(fieldName, maxFiles) : multerInstance.single(fieldName);

    upload(req, res, async (err: any) => {
      if (err) {
        return redirectUploadError(req, res, err.message || 'Upload failed');
      }

      const files = isArray ? (req.files as Express.Multer.File[]) : (req.file ? [req.file] : []);
      
      if (files && files.length > 0) {
        for (const file of files) {
            try {
              const scanResult = await scanFileWithClamAV(file.path);
              if (!scanResult.clean) {
                try { fs.unlinkSync(file.path); } catch { /* noop */ }
                return redirectUploadError(req, res, `Upload blocked: malware detected in ${file.originalname}.`);
              }
            } catch (scanErr: any) {
              // Fail open or closed? Fail closed for security.
              try { fs.unlinkSync(file.path); } catch { /* noop */ }
              return redirectUploadError(req, res, scanErr?.message || 'Upload blocked: malware scan failed.');
            }
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
  false,
  (req) => String((req.body as any)?.folder || '')
);

export const uploadChatFiles = createUpload(
    path.join(__dirname, '../../public/uploads/chat'),
    'chat',
    'files',
    true
);