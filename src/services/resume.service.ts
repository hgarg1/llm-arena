import fs from 'fs/promises';
import mammoth from 'mammoth';

export const extractResumeText = async (filePath: string, mimeType?: string) => {
  const buffer = await fs.readFile(filePath);
  const lower = (mimeType || '').toLowerCase();

  if (lower.includes('pdf') || filePath.toLowerCase().endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useWorkerFetch: false
    });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ');
      pages.push(text);
    }

    return pages.join('\n').trim();
  }

  if (lower.includes('word') || filePath.toLowerCase().endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }

  return buffer.toString('utf8');
};
