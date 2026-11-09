import { Request, Response } from 'express';
import { ModelRepository } from '../repositories/model.repository';
import {
  buildAbsoluteUrl,
  buildBreadcrumbSchema,
  buildModelDescription,
  buildSeo,
  buildWebPageSchema
} from '../services/seo.service';
import { renderOgImage } from '../services/og-image.service';

const modelRepo = new ModelRepository();

const normalizeList = (value: any) => {
  if (!value) return { allowlist: [], denylist: [], matchMode: 'exact' };
  if (Array.isArray(value)) return { allowlist: value, denylist: [], matchMode: 'exact' };
  if (typeof value === 'object') {
    return {
      allowlist: Array.isArray(value.allowlist) ? value.allowlist : [],
      denylist: Array.isArray(value.denylist) ? value.denylist : [],
      matchMode: value.match_mode || 'exact'
    };
  }
  return { allowlist: [], denylist: [], matchMode: 'exact' };
};

const isAllowed = (value: string, allowlist: string[], denylist: string[], matchMode: string) => {
  const matches = (item: string) => (matchMode === 'prefix' ? value.startsWith(item) : value === item);
  if (denylist.some(matches)) return false;
  if (allowlist.length === 0) return true;
  return allowlist.some(matches);
};

const filterModelsByEntitlements = (models: any[], entitlements: any) => {
  if (!entitlements || !entitlements.entitlementValue) return models;
  const providerPolicy = normalizeList(entitlements.entitlementValue('models.allowed_providers'));
  const idPolicy = normalizeList(entitlements.entitlementValue('models.allowed_ids'));
  const denyPolicy = normalizeList(entitlements.entitlementValue('models.denied_ids'));
  return models.filter(model => {
    const providerAllowed = isAllowed(String(model.api_provider || ''), providerPolicy.allowlist, providerPolicy.denylist, providerPolicy.matchMode);
    const idAllowed = isAllowed(String(model.id), idPolicy.allowlist, idPolicy.denylist, idPolicy.matchMode);
    const denyBlocked = denyPolicy.denylist.length > 0 && isAllowed(String(model.id), [], denyPolicy.denylist, denyPolicy.matchMode);
    return providerAllowed && idAllowed && !denyBlocked;
  });
};

export const apiList = async (req: Request, res: Response) => {
  const capability = req.query.capability as string;
  const models = await modelRepo.findAll({ capability });
  const entitlements = (req as any).entitlements;
  res.json(filterModelsByEntitlements(models, entitlements));
};

export const list = async (req: Request, res: Response) => {
  const search = req.query.q as string;
  const provider = req.query.provider as string;

  const models = await modelRepo.findAll({ search, provider });
  const entitlements = (req as any).entitlements;
  const filteredModels = filterModelsByEntitlements(models, entitlements);
  const allProviders = ['openai', 'anthropic', 'google', 'xai', 'zhipu', 'mock'];
  const hasFilters = Boolean(search || provider);

  res.render('models/list', {
    title: 'Models',
    seo: buildSeo({
      title: hasFilters ? 'Models Search' : 'Models',
      description: hasFilters
        ? 'Browse filtered model listings on LLM Arena by provider and search terms.'
        : 'Browse the public model catalog available for evaluation, replay tracking, and benchmark comparisons in LLM Arena.',
      canonicalPath: '/models',
      robots: hasFilters ? 'noindex,follow' : 'index,follow',
      ogImageUrl: buildAbsoluteUrl('/og/page/models.png'),
      structuredData: [
        buildWebPageSchema(
          hasFilters ? 'Models Search' : 'Models',
          hasFilters
            ? 'Browse filtered model listings on LLM Arena by provider and search terms.'
            : 'Browse the public model catalog available for evaluation, replay tracking, and benchmark comparisons in LLM Arena.',
          '/models'
        ),
        buildBreadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Models', path: '/models' }
        ])
      ]
    }),
    models: filteredModels,
    path: '/models',
    query: { search, provider },
    allProviders
  });
};

export const detail = async (req: Request, res: Response) => {
  const model = await modelRepo.findById(req.params.id);
  if (!model) return res.status(404).send('Model not found');

  const description = buildModelDescription(model);
  const canonicalPath = `/models/${model.id}`;

  res.render('models/detail', {
    title: model.name,
    seo: buildSeo({
      title: model.name,
      description,
      canonicalPath,
      robots: model.is_active ? 'index,follow' : 'noindex,follow',
      ogImageUrl: buildAbsoluteUrl(`/og/models/${model.id}.png`),
      structuredData: [
        buildWebPageSchema(model.name, description, canonicalPath),
        buildBreadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Models', path: '/models' },
          { name: model.name, path: canonicalPath }
        ])
      ]
    }),
    model,
    path: '/models'
  });
};

export const ogImage = async (req: Request, res: Response) => {
  const model = await modelRepo.findById(req.params.id);
  if (!model) return res.status(404).end();

  const png = renderOgImage({
    theme: 'models',
    eyebrow: model.api_provider.toUpperCase(),
    title: model.name,
    description: buildModelDescription(model),
    chips: (model.capabilities || []).slice(0, 3),
    metricLabel: 'Model status',
    metricValue: model.is_active ? 'Active listing' : 'Hidden listing',
    footerLeft: model.kind,
    footerRight: model.api_model_id
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(png);
};
