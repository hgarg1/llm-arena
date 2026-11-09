import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { BlobServiceClient } from '@azure/storage-blob';

const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
};

export const hasBlobStorage = () =>
  Boolean(process.env.AZURE_BLOB_CONNECTION_STRING && process.env.AZURE_BLOB_CONTAINER);

export type PersistedFile = {
  fileName: string;
  publicUrl: string;
  absolutePath: string | null;
  relativePath: string | null;
  storage: 'azure' | 'local';
};

export const saveLocalFile = async (buffer: Buffer, fileName: string, folder: string) => {
  const targetDir = path.join(process.cwd(), 'public', folder);
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, fileName);
  await fs.writeFile(targetPath, buffer);
  return {
    relativePath: `/${folder}/${fileName}`,
    absolutePath: targetPath
  };
};

export const uploadToAzure = async (buffer: Buffer, fileName: string, folder: string) => {
  const connectionString = process.env.AZURE_BLOB_CONNECTION_STRING;
  const containerName = process.env.AZURE_BLOB_CONTAINER;
  if (!connectionString || !containerName) return null;

  const client = BlobServiceClient.fromConnectionString(connectionString);
  const container = client.getContainerClient(containerName);
  await container.createIfNotExists();
  const blobName = `${folder}/${fileName}`;
  const blobClient = container.getBlockBlobClient(blobName);
  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: 'application/octet-stream' }
  });
  return blobClient.url;
};

export const persistUploadedFile = async (
  buffer: Buffer,
  fileName: string,
  folder: string,
  contentType?: string
): Promise<PersistedFile> => {
  if (hasBlobStorage()) {
    const connectionString = process.env.AZURE_BLOB_CONNECTION_STRING as string;
    const containerName = process.env.AZURE_BLOB_CONTAINER as string;
    const client = BlobServiceClient.fromConnectionString(connectionString);
    const container = client.getContainerClient(containerName);
    await container.createIfNotExists();
    const blobName = `${folder}/${fileName}`;
    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType || 'application/octet-stream'
      }
    });
    return {
      fileName,
      publicUrl: blobClient.url,
      absolutePath: null,
      relativePath: null,
      storage: 'azure'
    };
  }

  const local = await saveLocalFile(buffer, fileName, folder);
  return {
    fileName,
    publicUrl: local.relativePath,
    absolutePath: local.absolutePath,
    relativePath: local.relativePath,
    storage: 'local'
  };
};

export const deleteStoredFile = async (file: PersistedFile) => {
  if (file.storage === 'local' && file.absolutePath) {
    await fs.unlink(file.absolutePath).catch(() => undefined);
  }
};

export const writeTempFile = async (buffer: Buffer, fileName: string) => {
  const tempDir = path.join(os.tmpdir(), 'llm-arena');
  await ensureDir(tempDir);
  const tempPath = path.join(tempDir, `${Date.now()}-${fileName}`);
  await fs.writeFile(tempPath, buffer);
  return tempPath;
};

export const removeTempFile = async (filePath: string | null | undefined) => {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => undefined);
};
