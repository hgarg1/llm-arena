import { Request, Response } from 'express';
import { getRunnerStats } from '../../services/runner/stats';

export const runnerDashboard = async (req: Request, res: Response) => {
  const stats = await getRunnerStats();
  res.render('admin/runner/index', {
    title: 'Runner Health',
    path: '/admin/runner',
    stats,
    success: req.query.success,
    error: req.query.error
  });
};
