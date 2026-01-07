import { Request, Response } from 'express';
import { ModelRepository } from '../repositories/model.repository';

const modelRepo = new ModelRepository();

export const apiList = async (req: Request, res: Response) => {
    const capability = req.query.capability as string;
    const models = await modelRepo.findAll({ capability });
    res.json(models);
};

export const list = async (req: Request, res: Response) => {
  const search = req.query.q as string;
  const provider = req.query.provider as string;
  
  const models = await modelRepo.findAll({ search, provider });
  
  // Get unique providers for filter dropdown
  // Efficient way: distinct query, but for now map from result or separate query
  // Let's just do a separate grouping for the UI filter list if needed, or hardcode common ones
  const allProviders = ['openai', 'anthropic', 'google', 'xai', 'zhipu', 'mock']; 

  res.render('models/list', { 
      title: 'Models', 
      models, 
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
