import { Request, Response } from 'express';
import { ModelRepository } from '../repositories/model.repository';

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
  
  // Get unique providers for filter dropdown
  // Efficient way: distinct query, but for now map from result or separate query
  // Let's just do a separate grouping for the UI filter list if needed, or hardcode common ones
  const allProviders = ['openai', 'anthropic', 'google', 'xai', 'zhipu', 'mock']; 

  res.render('models/list', { 
      title: 'Models', 
      models: filteredModels, 
      path: '/models',
      query: { search, provider },
      allProviders
  });
};

export const detail = async (req: Request, res: Response) => {
  const model = await modelRepo.findById(req.params.id);
  if (!model) return res.status(404).send('Model not found');
  res.render('models/detail', { title: model.name, model, path: '/models' });
};
