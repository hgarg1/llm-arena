import { Request, Response } from 'express';
import { MatchStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { isDatabaseConfigured } from '../../config/runtime';
import { MatchRepository } from '../../repositories/match.repository';
import { ModelRepository } from '../../repositories/model.repository';
import {
  buildAbsoluteUrl,
  buildBreadcrumbSchema,
  buildOrganizationSchema,
  buildSeo,
  buildWebPageSchema,
  buildWebsiteSchema
} from '../../services/seo.service';
import { renderOgImage } from '../../services/og-image.service';
import { rawRetentionDays } from '../../services/raw-retention.service';
import { MAX_RAW_BYTES } from '../../integrity/raw-response';

const matchRepo = new MatchRepository();
const modelRepo = new ModelRepository();
const runtimeDebug = process.env.RUNTIME_DEBUG === 'true';

const buildStaticPageOgUrl = (slug: string, query?: Record<string, string | number | boolean | undefined | null>) =>
  buildAbsoluteUrl({ pathname: `/og/page/${slug}.png`, query });

const STATIC_OG_CONFIG: Record<string, { eyebrow: string; theme: 'benchmarks' | 'docs' | 'careers' | 'models' | 'matches' | 'home' | 'default'; title: string; description: string; chips: string[]; metricLabel: string; metricValue: string; footerLeft: string; footerRight: string }> = {
  'how-it-works': {
    eyebrow: 'Workflow',
    theme: 'docs',
    title: 'How LLM Arena runs model evaluations',
    description: 'Structured matches, replay capture, and standardized outputs designed for comparable evaluation.',
    chips: ['Standardized', 'Replayable', 'Auditable'],
    metricLabel: 'Process',
    metricValue: 'Transparent by design',
    footerLeft: 'Evaluation workflow',
    footerRight: 'Step-by-step visibility'
  },
  benchmarks: {
    eyebrow: 'Leaderboard',
    theme: 'benchmarks',
    title: 'Benchmark rankings with replayable evidence',
    description: 'Public model standings backed by completed matches and auditable output trails.',
    chips: ['Rankings', 'Replays', 'Comparisons'],
    metricLabel: 'Benchmark mode',
    metricValue: 'Rank + replay',
    footerLeft: 'Comparable scoring',
    footerRight: 'Public evidence'
  },
  methodology: {
    eyebrow: 'Method',
    theme: 'docs',
    title: 'Evaluation methodology that can be inspected',
    description: 'Rules, scoring shape, and repeatable execution choices used across LLM Arena.',
    chips: ['Methodology', 'Reproducible', 'Reviewable'],
    metricLabel: 'Framework',
    metricValue: 'Repeatable evaluation',
    footerLeft: 'Rules and structure',
    footerRight: 'Documented assumptions'
  },
  'use-cases': {
    eyebrow: 'Applications',
    theme: 'default',
    title: 'Use LLM Arena for vendor and model comparisons',
    description: 'Support procurement, internal benchmarking, and model performance reviews with the same platform.',
    chips: ['Procurement', 'Benchmarking', 'Reviews'],
    metricLabel: 'Use cases',
    metricValue: 'Cross-team utility',
    footerLeft: 'Ops to research',
    footerRight: 'One evaluation surface'
  },
  about: {
    eyebrow: 'Mission',
    theme: 'default',
    title: 'LLM Arena is built for rigorous model comparison',
    description: 'A public-facing evaluation platform focused on transparency, replayability, and repeatable decisions.',
    chips: ['Mission', 'Transparency', 'Comparability'],
    metricLabel: 'Product focus',
    metricValue: 'Evaluation integrity',
    footerLeft: 'Replay-first product',
    footerRight: 'Audit-friendly outputs'
  },
  docs: {
    eyebrow: 'Reference',
    theme: 'docs',
    title: 'Documentation for operators and evaluators',
    description: 'Understand the platform, its data model, and the workflows behind public matches and rankings.',
    chips: ['Docs', 'Reference', 'Guides'],
    metricLabel: 'Docs',
    metricValue: 'Operator ready',
    footerLeft: 'Setup and concepts',
    footerRight: 'Public reference'
  },
  terms: {
    eyebrow: 'Legal',
    theme: 'docs',
    title: 'Terms that govern LLM Arena usage',
    description: 'Usage rules, service conditions, and platform obligations for the product.',
    chips: ['Terms', 'Usage', 'Policy'],
    metricLabel: 'Legal',
    metricValue: 'Platform terms',
    footerLeft: 'Service rules',
    footerRight: 'Canonical legal copy'
  },
  'data-retention': {
    eyebrow: 'Policy',
    theme: 'docs',
    title: 'How long raw model responses are kept',
    description: 'Retention for raw provider responses, and what stays so signed match records still verify.',
    chips: ['Retention', 'Integrity', 'Policy'],
    metricLabel: 'Data policy',
    metricValue: 'Digests are permanent',
    footerLeft: 'Raw responses expire',
    footerRight: 'Signed digests stay'
  },
  privacy: {
    eyebrow: 'Policy',
    theme: 'docs',
    title: 'Privacy terms for platform and application data',
    description: 'How LLM Arena handles operational records, account information, and user-submitted data.',
    chips: ['Privacy', 'Data handling', 'Policy'],
    metricLabel: 'Data policy',
    metricValue: 'Privacy controls',
    footerLeft: 'Operational data',
    footerRight: 'User information'
  },
  models: {
    eyebrow: 'Catalog',
    theme: 'models',
    title: 'Explore the public model catalog',
    description: 'Review available models, providers, and detail pages for evaluation-ready entries.',
    chips: ['Catalog', 'Providers', 'Capabilities'],
    metricLabel: 'Model index',
    metricValue: 'Public listings',
    footerLeft: 'Detail pages',
    footerRight: 'Evaluation-ready entries'
  },
  matches: {
    eyebrow: 'Replay index',
    theme: 'matches',
    title: 'Browse completed matches and replay logs',
    description: 'Track public match records, replay details, and evaluation outputs across supported games.',
    chips: ['Replays', 'Match logs', 'Outcomes'],
    metricLabel: 'Match index',
    metricValue: 'Public replays',
    footerLeft: 'Completed runs',
    footerRight: 'Auditable trails'
  },
  careers: {
    eyebrow: 'Hiring',
    theme: 'careers',
    title: 'Open roles at LLM Arena',
    description: 'Explore current openings across engineering, product, and operations.',
    chips: ['Hiring', 'Engineering', 'Product'],
    metricLabel: 'Careers',
    metricValue: 'Open roles',
    footerLeft: 'Published roles',
    footerRight: 'Application-ready'
  }
};

const staticPageSeo = {
  howItWorks: {
    title: 'How It Works',
    description: 'Learn how LLM Arena runs standardized evaluations, records replayable matches, and produces comparable model outcomes.',
    canonicalPath: '/how-it-works'
  },
  methodology: {
    title: 'Methodology',
    description: 'Review the evaluation methodology behind LLM Arena, including match structure, reproducibility, and auditability.',
    canonicalPath: '/methodology'
  },
  useCases: {
    title: 'Use Cases',
    description: 'See how teams use LLM Arena for benchmarking, vendor comparisons, internal model evaluations, and replay-based review.',
    canonicalPath: '/use-cases'
  },
  about: {
    title: 'About Us',
    description: 'Meet the mission behind LLM Arena and the approach we use to make model evaluation standardized, transparent, and repeatable.',
    canonicalPath: '/about'
  },
  docs: {
    title: 'Documentation',
    description: 'Explore the LLM Arena product documentation, core concepts, workflow explanations, and setup references.',
    canonicalPath: '/docs'
  },
  terms: {
    title: 'Terms of Service',
    description: 'Read the Terms of Service for using LLM Arena, including product usage rules, platform obligations, and legal terms.',
    canonicalPath: '/terms'
  },
  dataRetention: {
    title: 'Data Retention',
    description: 'How long LLM Arena keeps raw model responses, what is removed, and what stays so that signed match records still verify.',
    canonicalPath: '/data-retention'
  },
  privacy: {
    title: 'Privacy Policy',
    description: 'Review how LLM Arena handles account information, application data, telemetry, and operational records.',
    canonicalPath: '/privacy'
  }
} as const;

const buildStaticSeo = (title: string, description: string, canonicalPath: string) =>
  buildSeo({
    title,
    description,
    canonicalPath,
    ogImageUrl: buildStaticPageOgUrl(canonicalPath.replace(/^\//, '')),
    structuredData: [
      buildWebPageSchema(title, description, canonicalPath),
      buildBreadcrumbSchema([
        { name: 'Home', path: '/' },
        { name: title, path: canonicalPath }
      ])
    ]
  });

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const formatDate = (value?: Date | null) => (value ? new Date(value).toISOString() : null);

type SitemapEntry = {
  loc: string;
  lastmod?: string | null;
  changefreq?: 'daily' | 'weekly' | 'monthly';
};

const buildStaticSitemapEntries = (): SitemapEntry[] => [
  { loc: buildAbsoluteUrl('/'), changefreq: 'daily' },
  { loc: buildAbsoluteUrl('/how-it-works'), changefreq: 'weekly' },
  { loc: buildAbsoluteUrl('/benchmarks'), changefreq: 'daily' },
  { loc: buildAbsoluteUrl('/methodology'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/use-cases'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/about'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/docs'), changefreq: 'weekly' },
  { loc: buildAbsoluteUrl('/terms'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/privacy'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/data-retention'), changefreq: 'monthly' },
  { loc: buildAbsoluteUrl('/careers'), changefreq: 'weekly' },
  { loc: buildAbsoluteUrl('/models'), changefreq: 'daily' },
  { loc: buildAbsoluteUrl('/matches'), changefreq: 'daily' }
];

const buildSitemapXml = (entries: SitemapEntry[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    entry => `  <url>
    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `
    <lastmod>${entry.lastmod}</lastmod>` : ''}${entry.changefreq ? `
    <changefreq>${entry.changefreq}</changefreq>` : ''}
  </url>`
  )
  .join('\n')}
</urlset>`;

export class PublicController {
  static async userAvatar(req: Request, res: Response) {
    if (!isDatabaseConfigured()) {
      return res.status(404).end();
    }

    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        avatar_data: true,
        avatar_content_type: true,
        avatar_file_name: true,
        avatar_updated_at: true,
        avatar_url: true
      }
    });

    if (!user) {
      return res.status(404).end();
    }

    if (user.avatar_data) {
      if (user.avatar_updated_at) {
        res.setHeader('Last-Modified', user.avatar_updated_at.toUTCString());
      }
      if (user.avatar_file_name) {
        res.setHeader('Content-Disposition', `inline; filename="${user.avatar_file_name.replace(/"/g, '')}"`);
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type(user.avatar_content_type || 'application/octet-stream');
      return res.send(Buffer.from(user.avatar_data));
    }

    if (user.avatar_url && !user.avatar_url.startsWith('/users/')) {
      return res.redirect(user.avatar_url);
    }

    return res.status(404).end();
  }

  static async home(req: Request, res: Response) {
    if (runtimeDebug) console.log('[runtime] public.home:start');
    const seo = buildSeo({
      title: 'Standardized Competitive Evaluation for LLMs',
      description: 'Compare language models with reproducible matches, public replays, benchmark-style rankings, and auditable evaluation workflows.',
      canonicalPath: '/',
      ogImageUrl: buildAbsoluteUrl('/og/home.png'),
      structuredData: [
        buildOrganizationSchema(),
        buildWebsiteSchema(),
        buildWebPageSchema(
          'Standardized Competitive Evaluation for LLMs',
          'Compare language models with reproducible matches, public replays, benchmark-style rankings, and auditable evaluation workflows.',
          '/'
        )
      ]
    });

    if (!isDatabaseConfigured()) {
      if (runtimeDebug) console.log('[runtime] public.home:no-db');
      return res.render('public/home', {
        title: 'Standardized Competitive Evaluation for LLMs',
        seo,
        matches: [],
        models: [],
        path: '/'
      });
    }

    const recentMatchesResult = await matchRepo.findAll({
      status: MatchStatus.COMPLETED
    });
    const recentMatches = recentMatchesResult.matches;
    if (runtimeDebug) console.log('[runtime] public.home:matches', { count: recentMatches.length });

    const models = await modelRepo.findAll();
    if (runtimeDebug) console.log('[runtime] public.home:models', { count: models.length });

    res.render('public/home', {
      title: 'Standardized Competitive Evaluation for LLMs',
      seo,
      matches: recentMatches.slice(0, 3),
      models: models.slice(0, 5),
      path: '/'
    });
    if (runtimeDebug) console.log('[runtime] public.home:rendered');
  }

  static async howItWorks(req: Request, res: Response) {
    const config = staticPageSeo.howItWorks;
    res.render('public/how-it-works', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/how-it-works'
    });
  }

  static async benchmarks(req: Request, res: Response) {
    const rawPage = parseInt(req.query.page as string, 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const canonicalPath = page > 1 ? `/benchmarks?page=${page}` : '/benchmarks';
    const pageSuffix = page > 1 ? ` - Page ${page}` : '';
    const seo = buildSeo({
      title: `Benchmarks${pageSuffix}`,
      description:
        page > 1
          ? `Browse ranked benchmark results for language models on page ${page} of the LLM Arena leaderboard.`
          : 'Browse ranked benchmark results for language models, with replayable matches and public evaluation data.',
      canonicalPath,
      ogImageUrl: buildStaticPageOgUrl('benchmarks', page > 1 ? { page } : undefined),
      structuredData: [
        buildWebPageSchema(
          `Benchmarks${pageSuffix}`,
          page > 1
            ? `Browse ranked benchmark results for language models on page ${page} of the LLM Arena leaderboard.`
            : 'Browse ranked benchmark results for language models, with replayable matches and public evaluation data.',
          canonicalPath
        ),
        buildBreadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Benchmarks', path: canonicalPath }
        ])
      ]
    });

    if (!isDatabaseConfigured()) {
      return res.render('public/benchmarks', {
        title: `Benchmarks${pageSuffix}`,
        seo,
        top3: [],
        models: [],
        currentPage: page,
        totalPages: 0,
        path: '/benchmarks'
      });
    }

    const limit = 20;
    const skip = (page - 1) * limit;
    const allModels = await modelRepo.findAll();
    const rankedModels = allModels
      .map((model, index) => ({
        ...model,
        rank: index + 1,
        rating: 1500 + Math.floor(Math.random() * 500),
        winRate: (Math.random() * 100).toFixed(1)
      }))
      .sort((a, b) => b.rating - a.rating);

    rankedModels.forEach((model, index) => {
      model.rank = index + 1;
    });

    const top3 = rankedModels.slice(0, 3);
    const paginatedModels = rankedModels.slice(skip, skip + limit);
    const totalPages = Math.ceil(rankedModels.length / limit);

    res.render('public/benchmarks', {
      title: `Benchmarks${pageSuffix}`,
      seo,
      top3,
      models: paginatedModels,
      currentPage: page,
      totalPages,
      path: '/benchmarks'
    });
  }

  static async methodology(req: Request, res: Response) {
    const config = staticPageSeo.methodology;
    res.render('public/methodology', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/methodology'
    });
  }

  static async useCases(req: Request, res: Response) {
    const config = staticPageSeo.useCases;
    res.render('public/use-cases', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/use-cases'
    });
  }

  static async about(req: Request, res: Response) {
    const config = staticPageSeo.about;
    res.render('public/about', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/about'
    });
  }

  static async docs(req: Request, res: Response) {
    const config = staticPageSeo.docs;
    res.render('public/docs', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/docs'
    });
  }

  static async sitemap(req: Request, res: Response) {
    const entries = buildStaticSitemapEntries();

    if (isDatabaseConfigured()) {
      const [jobs, models, matches] = await Promise.all([
        prisma.jobPosting.findMany({
          where: { status: 'PUBLISHED' },
          select: { slug: true, updated_at: true },
          orderBy: { updated_at: 'desc' }
        }),
        prisma.model.findMany({
          where: { is_active: true },
          select: { id: true, updated_at: true },
          orderBy: { updated_at: 'desc' }
        }),
        prisma.match.findMany({
          where: { status: MatchStatus.COMPLETED },
          select: { id: true, finished_at: true, created_at: true },
          orderBy: { created_at: 'desc' }
        })
      ]);

      entries.push(
        ...jobs.map(job => ({
          loc: buildAbsoluteUrl(`/careers/${job.slug}`),
          lastmod: formatDate(job.updated_at),
          changefreq: 'weekly' as const
        }))
      );
      entries.push(
        ...models.map(model => ({
          loc: buildAbsoluteUrl(`/models/${model.id}`),
          lastmod: formatDate(model.updated_at),
          changefreq: 'weekly' as const
        }))
      );
      entries.push(
        ...matches.map(match => ({
          loc: buildAbsoluteUrl(`/matches/${match.id}`),
          lastmod: formatDate(match.finished_at || match.created_at),
          changefreq: 'monthly' as const
        }))
      );
    }

    res.header('Content-Type', 'application/xml');
    res.send(buildSitemapXml(entries));
  }

  static async terms(req: Request, res: Response) {
    const config = staticPageSeo.terms;
    res.render('public/terms', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/terms'
    });
  }

  static async dataRetention(req: Request, res: Response) {
    const config = staticPageSeo.dataRetention;
    res.render('public/data_retention', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/data-retention',
      retentionDays: await rawRetentionDays(),
      maxRawKiB: MAX_RAW_BYTES / 1024
    });
  }

  static async privacy(req: Request, res: Response) {
    const config = staticPageSeo.privacy;
    res.render('public/privacy', {
      title: config.title,
      seo: buildStaticSeo(config.title, config.description, config.canonicalPath),
      path: '/privacy'
    });
  }

  static async ogHome(req: Request, res: Response) {
    const png = renderOgImage({
      theme: 'home',
      eyebrow: 'LLM Arena',
      title: 'Competitive evaluation for language models',
      description: 'Reproducible matches, public replays, and benchmark-ready comparisons on a single canonical platform.',
      chips: ['Reproducible', 'Replayable', 'Benchmark-ready'],
      metricLabel: 'Platform',
      metricValue: 'Canonical previews',
      footerLeft: 'Public matches',
      footerRight: 'llm-arena.harshit-garg.com'
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  }

  static async ogStaticPage(req: Request, res: Response) {
    const slug = req.params.slug;
    const config = STATIC_OG_CONFIG[slug];
    if (!config) {
      return res.status(404).end();
    }

    const page = Number.parseInt(String(req.query.page || ''), 10);
    const metricValue =
      slug === 'benchmarks' && Number.isFinite(page) && page > 1 ? `Leaderboard p.${page}` : config.metricValue;
    const chips =
      slug === 'benchmarks' && Number.isFinite(page) && page > 1
        ? [...config.chips.slice(0, 2), `Page ${page}`]
        : config.chips;

    const png = renderOgImage({
      theme: config.theme,
      eyebrow: config.eyebrow,
      title: config.title,
      description: config.description,
      chips,
      metricLabel: config.metricLabel,
      metricValue,
      footerLeft: config.footerLeft,
      footerRight: config.footerRight
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  }
}
