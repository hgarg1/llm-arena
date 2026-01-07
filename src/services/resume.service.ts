import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

export const extractResumeText = async (filePath: string, mimeType?: string) => {
  const buffer = await fs.readFile(filePath);
  const lower = (mimeType || '').toLowerCase();

  if (lower.includes('pdf') || filePath.toLowerCase().endsWith('.pdf')) {
    const parsePdf = pdfParse as unknown as (data: Buffer) => Promise<{ text?: string }>;
    const parsed = await parsePdf(buffer);
    return parsed.text || '';
  }

  if (lower.includes('word') || filePath.toLowerCase().endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }

  return buffer.toString('utf8');
};
