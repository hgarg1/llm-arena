import { Request, Response } from 'express';
import { storage } from '../../services/storage.service';
import { logAdminAction } from '../../services/audit.service';
import fs from 'fs';
import path from 'path';

const PUBLIC_ROOT = path.join(__dirname, '../../../public');
const IMG_ROOT = path.join(PUBLIC_ROOT, 'img');
const AVATAR_ROOT = path.join(PUBLIC_ROOT, 'uploads/avatars');

const normalizeRelPath = (value: string) => {
    const cleaned = value.replace(/\\/g, '/').replace(/^\//, '');
    const normalized = path.posix.normalize(cleaned);
    if (normalized.startsWith('..')) return '';
    return normalized === '.' ? '' : normalized;
};

const listFolders = (root: string) => {
    const folders: string[] = [''];
    if (!fs.existsSync(root)) return folders;
    const walk = (dir: string, base: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach(entry => {
            if (entry.isDirectory()) {
                const rel = path.posix.join(base, entry.name);
                folders.push(rel);
                walk(path.join(dir, entry.name), rel);
            }
        });
    };
    walk(root, '');
    return folders.sort((a, b) => a.localeCompare(b));
};

const listFiles = (root: string, relDir: string) => {
    const targetDir = path.join(root, relDir);
    if (!fs.existsSync(targetDir)) return [];
    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    return files
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .map(entry => {
            const fullPath = path.join(targetDir, entry.name);
            const stat = fs.statSync(fullPath);
            return {
                name: entry.name,
                size: stat.size,
                modified: stat.mtime,
                relPath: path.posix.join(relDir.replace(/\\/g, '/'), entry.name).replace(/^\/+/, '')
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
};

export const mediaList = async (req: Request, res: Response) => {
    const folder = normalizeRelPath(String(req.query.folder || ''));
    const folders = listFolders(IMG_ROOT);
    const images = listFiles(IMG_ROOT, folder);
    const avatarImages = listFiles(AVATAR_ROOT, '');
    
    res.render('admin/media/index', { 
        title: 'Media Library', 
        path: '/admin/media', 
        images,
        avatarImages,
        folders,
        currentFolder: folder,
        success: req.query.success,
        error: req.query.error
    });
};

export const uploadMedia = async (req: Request, res: Response) => {
    // Handled by middleware mostly, just redirect
    if (req.file) {
        await logAdminAction((req.session as any).userId, 'media.upload', req.file.filename);
    }
    const folder = normalizeRelPath(String(req.body.folder || ''));
    res.redirect(`/admin/media?success=Uploaded&folder=${encodeURIComponent(folder)}`);
};

export const createFolder = async (req: Request, res: Response) => {
    const name = String(req.body.name || '').trim();
    const parent = normalizeRelPath(String(req.body.parent || ''));
    if (!name) return res.redirect('/admin/media?error=Folder name required');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return res.redirect('/admin/media?error=Folder name must be alphanumeric with dashes or underscores');
    }

    const target = path.join(IMG_ROOT, parent, name);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(IMG_ROOT))) {
        return res.redirect('/admin/media?error=Invalid folder path');
    }
    if (fs.existsSync(resolved)) {
        return res.redirect('/admin/media?error=Folder already exists');
    }
    fs.mkdirSync(resolved, { recursive: true });
    await logAdminAction((req.session as any).userId, 'media.folder.create', path.posix.join(parent, name));
    res.redirect(`/admin/media?success=Folder created&folder=${encodeURIComponent(path.posix.join(parent, name))}`);
};

export const deleteFolder = async (req: Request, res: Response) => {
    const folder = normalizeRelPath(String(req.body.folder || ''));
    if (!folder) return res.redirect('/admin/media?error=Select a folder to delete');
    const target = path.join(IMG_ROOT, folder);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(IMG_ROOT))) {
        return res.redirect('/admin/media?error=Invalid folder path');
    }
    if (!fs.existsSync(resolved)) {
        return res.redirect('/admin/media?error=Folder not found');
    }
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0) {
        return res.redirect('/admin/media?error=Folder must be empty before deletion');
    }
    fs.rmdirSync(resolved);
    await logAdminAction((req.session as any).userId, 'media.folder.delete', folder);
    res.redirect('/admin/media?success=Folder deleted');
};

export const deleteMedia = async (req: Request, res: Response) => {
    const filename = String(req.body.filename || '');
    const dir = normalizeRelPath(String(req.body.dir || 'img'));
    if (!filename) return res.redirect('/admin/media?error=Missing filename');
    await storage.delete(filename, dir || 'img');
    await logAdminAction((req.session as any).userId, 'media.delete', filename, { dir });
    res.redirect(`/admin/media?success=Deleted&folder=${encodeURIComponent(dir.replace(/^img\/?/, ''))}`);
};
