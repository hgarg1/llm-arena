process.env.DATABASE_URL = 'postgres://test';
const getAll = jest.fn();
jest.mock('../src/config/db', () => ({ prisma: {} }));
jest.mock('../src/services/settings.service', () => ({ settingsService: { getAll, defaults: {} } }));
jest.mock('../src/repositories/match.repository', () => ({ MatchRepository: class {} }));
jest.mock('../src/repositories/model.repository', () => ({ ModelRepository: class {} }));
jest.mock('../src/services/og-image.service', () => ({ renderOgImage: jest.fn() }));

import fs from 'fs';
import path from 'path';
import { PublicController } from '../src/controllers/public/public.controller';
import { MAX_RAW_BYTES } from '../src/integrity/raw-response';

const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const page = async () => {
  const res: any = { rendered: undefined as any };
  res.render = (view: string, data: any) => { res.rendered = { view, data }; };
  await PublicController.dataRetention({} as any, res);
  return res.rendered as { view: string; data: any };
};

describe('GET /data-retention', () => {
  beforeEach(() => getAll.mockReset().mockResolvedValue({}));

  it('reports the window the sweeper uses, and the size limit from code', async () => {
    const { view, data } = await page();
    expect(view).toBe('public/data_retention');
    expect(data.retentionDays).toBe(90);
    expect(data.maxRawKiB).toBe(MAX_RAW_BYTES / 1024);
    getAll.mockResolvedValue({ integrity_raw_retention_days: '14' });
    expect((await page()).data.retentionDays).toBe(14);
    getAll.mockResolvedValue({ integrity_raw_retention_days: 'garbage' });
    expect((await page()).data.retentionDays).toBe(90);
    getAll.mockResolvedValue({ integrity_raw_retention_days: '0' });
    expect((await page()).data.retentionDays).toBe(0);
  });

  it('is routed, in the sitemap, and linked from the methodology, privacy and admin settings pages', () => {
    expect(read('src/routes/public.routes.ts')).toContain("router.get('/data-retention', PublicController.dataRetention)");
    expect(read('src/controllers/public/public.controller.ts')).toContain("buildAbsoluteUrl('/data-retention')");
    for (const file of ['views/public/methodology.ejs', 'views/public/privacy.ejs', 'views/admin/settings/index.ejs']) expect(read(file)).toContain('/data-retention');
  });

  it('has an admin setting that is whitelisted, defaulted to 90 and validated', () => {
    expect(read('src/controllers/admin.controller.ts')).toContain("'integrity_raw_retention_days'");
    expect(read('src/services/settings.service.ts')).toContain("integrity_raw_retention_days: '90'");
    expect(read('views/admin/settings/index.ejs')).toContain('name="integrity_raw_retention_days"');
  });

  it('the page text states what stays and says nothing that the code does not do', () => {
    const view = read('views/public/data_retention.ejs');
    expect(view).toContain('SHA-256 digest');
    expect(view).toContain('<%= retentionDays %>');
    expect(view).toContain('<%= maxRawKiB %>');
    expect(view).not.toMatch(/INTEGRITY_RAW_RETENTION_DAYS/);
  });
});
