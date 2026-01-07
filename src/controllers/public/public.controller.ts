import { Request, Response } from 'express';
import { MatchRepository } from '../../repositories/match.repository';
import { ModelRepository } from '../../repositories/model.repository';
import { MatchStatus } from '@prisma/client';

const matchRepo = new MatchRepository();
const modelRepo = new ModelRepository();

export class PublicController {
  
  static async home(req: Request, res: Response) {
    // Fetch data for widgets
    const recentMatchesResult = await matchRepo.findAll({
        status: MatchStatus.COMPLETED
    }); 
    const recentMatches = recentMatchesResult.matches;
    
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
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    
    // For now, we mock the leaderboard ranking based on created_at or random score
    // In a real app, we'd have a Leaderboard model or aggregation query.
    // We'll fetch ALL models for now to sort/rank them in memory (MVP), then slice.
    // Optimization: Add 'score' or 'rating' field to Model and sort by that in DB.
    
    // Fetch all for ranking (MVP)
    const allModels = await modelRepo.findAll();
    
    // Assign Mock Scores for demo if not present
    const rankedModels = allModels.map((m, i) => ({
        ...m,
        rank: i + 1,
        rating: 1500 + Math.floor(Math.random() * 500), // Mock ELO
        winRate: (Math.random() * 100).toFixed(1)
    })).sort((a, b) => b.rating - a.rating); // Sort by rating

    // Recalculate rank after sort
    rankedModels.forEach((m, i) => m.rank = i + 1);

    const top3 = rankedModels.slice(0, 3);
    const paginatedModels = rankedModels.slice(skip, skip + limit);
    const totalPages = Math.ceil(rankedModels.length / limit);

    res.render('public/benchmarks', {
      title: 'Benchmarks',
      top3,
      models: paginatedModels,
      currentPage: page,
      totalPages,
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
      '/terms',
      '/privacy',
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

  static async terms(req: Request, res: Response) {
    res.render('public/terms', { title: 'Terms of Service', path: '/terms' });
  }

  static async privacy(req: Request, res: Response) {
    res.render('public/privacy', { title: 'Privacy Policy', path: '/privacy' });
  }
}
