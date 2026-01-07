import path from 'path';
import fs from 'fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';

const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
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
