import fs from 'fs';
import path from 'path';

export interface IStorageProvider {
    list(dir: string): Promise<string[]>;
    save(file: Express.Multer.File, dir: string): Promise<string>;
    delete(filename: string, dir: string): Promise<void>;
}

export class LocalStorageProvider implements IStorageProvider {
    async list(dir: string): Promise<string[]> {
        const fullPath = path.join(__dirname, '../../public', dir);
        if (!fs.existsSync(fullPath)) return [];
        return fs.readdirSync(fullPath).filter(f => !f.startsWith('.'));
    }

    async save(file: Express.Multer.File, dir: string): Promise<string> {
        // Multer already saves to temp or dest, we just ensure it's in the right place
        // If using DiskStorage in middleware, it's already there. 
        // We just return the public URL.
        return path.join('/', dir, file.filename).replace(/\\/g, '/');
    }

    async delete(filename: string, dir: string): Promise<void> {
        const fullPath = path.join(__dirname, '../../public', dir, filename);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    }
}

export class AzureBlobProvider implements IStorageProvider {
    // Placeholder for future implementation
    async list(dir: string): Promise<string[]> { return []; }
    async save(file: Express.Multer.File, dir: string): Promise<string> { return ''; }
    async delete(filename: string, dir: string): Promise<void> { }
}

export const storage = process.env.AZURE_STORAGE_CONN_STRING ? new AzureBlobProvider() : new LocalStorageProvider();
