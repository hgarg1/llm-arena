import { Request, Response } from 'express';
import { MatchService } from '../services/match.service';
import { ModelRepository } from '../repositories/model.repository';

const matchService = new MatchService();
const modelRepo = new ModelRepository();

export const list = async (req: Request, res: Response) => {
  const matches = await matchService.listMatches();
  res.render('matches/list', { title: 'Matches', matches, path: '/matches' });
};

export const createPage = async (req: Request, res: Response) => {
  const models = await modelRepo.findAll();
  res.render('matches/create', { title: 'Create Match', models, path: '/matches' });
};

export const create = async (req: Request, res: Response) => {
  const { model1Id, model2Id } = req.body;
  if (!model1Id || !model2Id) {
    return res.status(400).send('Select two models');
  }
  
  await matchService.createMatch([model1Id, model2Id]);
  res.redirect('/matches');
};

export const detail = async (req: Request, res: Response) => {
  const match = await matchService.getMatch(req.params.id);
  if (!match) return res.status(404).send('Match not found');
  res.render('matches/detail', { title: 'Match Replay', match, path: '/matches' });
};

export const events = async (req: Request, res: Response) => {
    const match = await matchService.getMatch(req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match.events);
}
