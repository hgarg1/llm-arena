import { execFile } from 'child_process';
import path from 'path';

const PUBLIC_ROOT = path.join(__dirname, '../../public');

const getConfig = () => ({
  enabled: (process.env.CLAMAV_ENABLED || 'true').toLowerCase() !== 'false',
  service: process.env.CLAMAV_SERVICE_NAME || 'clamav',
  scanRoot: process.env.CLAMAV_SCAN_ROOT || '/scan'
});

const toContainerPath = (filePath: string) => {
  const relative = path.relative(PUBLIC_ROOT, filePath).replace(/\\/g, '/');
  if (relative.startsWith('..')) return null;
  return path.posix.join(getConfig().scanRoot, relative);
};

export const scanFileWithClamAV = (filePath: string): Promise<{ clean: boolean; output: string }> => {
  const { enabled, service } = getConfig();
  if (!enabled) {
    return Promise.resolve({ clean: true, output: 'scan disabled' });
  }
  const target = toContainerPath(filePath);
  if (!target) {
    return Promise.resolve({ clean: false, output: 'Invalid scan target' });
  }

  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', service, 'clamscan', '--no-summary', '--infected', target],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (!error) {
          return resolve({ clean: true, output });
        }
        const code = (error as any).code;
        if (code === 1) {
          return resolve({ clean: false, output });
        }
        return reject(new Error(output || 'ClamAV scan failed'));
      }
    );
  });
};
