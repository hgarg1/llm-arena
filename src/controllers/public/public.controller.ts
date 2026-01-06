import { Request, Response } from 'express';
import { MatchRepository } from '../../repositories/match.repository';
import { ModelRepository } from '../../repositories/model.repository';
import { MatchStatus } from '@prisma/client';

const matchRepo = new MatchRepository();
const modelRepo = new ModelRepository();

export class PublicController {
  
  static async home(req: Request, res: Response) {
    // Fetch data for widgets
    const recentMatches = await matchRepo.findAll({
        status: MatchStatus.COMPLETED
    }); // findAll already sorts desc and takes 50, we'll slice 3
    
    // Simple leaderboard calc (just win count for MVP widget)
    // In a real app, we'd have a LeaderboardService
    const models = await modelRepo.findAll();
    // For now, just pass models. Real leaderboard would need aggregation query.
    
    res.render('public/home', {
      title: 'Standardized Competitive Evaluation for LLMs',
      matches: recentMatches.slice(0, 3),
      models: models.slice(0, 5), // Mock top 5
      path: '/'
    });
  }

  static async howItWorks(req: Request, res: Response) {
    res.render('public/how-it-works', {
      title: 'How It Works',
      path: '/how-it-works'
    });
  }

  static async benchmarks(req: Request, res: Response) {
    const models = await modelRepo.findAll();
    res.render('public/benchmarks', {
      title: 'Benchmarks',
      models,
      path: '/benchmarks'
    });
  }

  static async methodology(req: Request, res: Response) {
    res.render('public/methodology', {
      title: 'Methodology',
      path: '/methodology'
    });
  }

  static async useCases(req: Request, res: Response) {
    res.render('public/use-cases', {
      title: 'Use Cases',
      path: '/use-cases'
    });
  }

  static async about(req: Request, res: Response) {
    res.render('public/about', {
      title: 'About Us',
      path: '/about'
    });
  }

  static async docs(req: Request, res: Response) {
    res.render('public/docs', {
      title: 'Documentation',
      path: '/docs'
    });
  }

  static async sitemap(req: Request, res: Response) {
    const baseUrl = 'https://llmarena.com'; // Change in prod
    const urls = [
      '/',
      '/how-it-works',
      '/benchmarks',
      '/methodology',
      '/use-cases',
      '/about',
      '/docs',
      '/models',
      '/matches'
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      ${urls.map(url => `
        <url>
          <loc>${baseUrl}${url}</loc>
          <changefreq>daily</changefreq>
        </url>
      `).join('')}
    </urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  }
}
