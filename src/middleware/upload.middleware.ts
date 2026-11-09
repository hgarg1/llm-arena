import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { scanFileWithClamAV } from '../services/clamav.service';
import { deleteStoredFile, persistUploadedFile, removeTempFile, writeTempFile } from '../services/storage.service';

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Allow images, PDFs, text, zip
  const allowed = ['image/', 'application/pdf', 'text/', 'application/zip', 'application/x-zip-compressed'];
  if (allowed.some(t => file.mimetype.startsWith(t))) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
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

type UploadMode = 'persist' | 'memory';

const createUpload = (
  destDir: string,
  prefix: string,
  fieldName: string,
  isArray = false,
  resolveSubdir?: (req: Request) => string,
  mode: UploadMode = 'persist'
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const settings = res.locals.settings || {};
    const maxMb = parseInt(settings.upload_max_mb || '10', 10);
    const maxFiles = parseInt(settings.chat_max_upload_count || '5', 10);

    const multerInstance = multer({
      storage: multer.memoryStorage(),
      fileFilter,
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
            const enriched = file as Express.Multer.File & {
              storageUrl?: string;
              relativePath?: string | null;
              absolutePath?: string | null;
            };

            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const generatedName = `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`;
            enriched.filename = generatedName;

            let tempPath: string | null = null;
            let stored: Awaited<ReturnType<typeof persistUploadedFile>> | null = null;
            try {
              tempPath = await writeTempFile(file.buffer, generatedName);
              const scanResult = await scanFileWithClamAV(tempPath);
              if (!scanResult.clean) {
                return redirectUploadError(req, res, `Upload blocked: malware detected in ${file.originalname}.`);
              }

              if (mode === 'persist') {
                const subdir = resolveSubdir ? sanitizeSubdir(resolveSubdir(req)) : '';
                const relativeRoot = path.relative(path.join(__dirname, '../../public'), destDir).replace(/\\/g, '/');
                const finalFolder = subdir ? `${relativeRoot}/${subdir}` : relativeRoot;
                stored = await persistUploadedFile(file.buffer, generatedName, finalFolder, file.mimetype);
                enriched.path = stored.absolutePath || stored.publicUrl;
                enriched.storageUrl = stored.publicUrl;
                enriched.relativePath = stored.relativePath;
                enriched.absolutePath = stored.absolutePath;
              } else {
                enriched.path = tempPath;
                enriched.storageUrl = undefined;
                enriched.relativePath = null;
                enriched.absolutePath = tempPath;
              }
            } catch (scanErr: any) {
              if (stored) {
                await deleteStoredFile(stored);
              }
              return redirectUploadError(req, res, scanErr?.message || 'Upload blocked: malware scan failed.');
            } finally {
              if (tempPath) {
                await removeTempFile(tempPath);
              }
            }
        }
      }
      return next();
    });
  };
};

export const uploadAvatar = createUpload(path.join(__dirname, '../../public/uploads/avatars'), 'avatar', 'avatar', false, undefined, 'memory');
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
