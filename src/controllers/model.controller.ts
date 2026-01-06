import { Request, Response } from 'express';
import { ModelRepository } from '../repositories/model.repository';

const modelRepo = new ModelRepository();

export const list = async (req: Request, res: Response) => {
  const models = await modelRepo.findAll();
  res.render('models/list', { title: 'Models', models, path: '/models' });
};

export const detail = async (req: Request, res: Response) => {
  const model = await modelRepo.findById(req.params.id);
  if (!model) return res.status(404).send('Model not found');
  res.render('models/detail', { title: model.name, model, path: '/models' });
};
