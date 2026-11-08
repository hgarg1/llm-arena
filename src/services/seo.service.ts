import type { JobPosting, MatchStatus, Model } from '@prisma/client';
import { getSiteUrl } from '../config/runtime';

export const DEFAULT_SEO_DESCRIPTION =
  'Standardized competitive evaluation for language models with reproducible matches, auditable replays, and comparable benchmark workflows.';

const DEFAULT_OG_IMAGE_PATH = '/og/home.png';
const OG_IMAGE_VERSION =
  process.env.OG_IMAGE_VERSION ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_DEPLOYMENT_ID ||
  '20260403-preview-fix';

const withOgVersion = (urlValue: string) => {
  const url = new URL(urlValue, getSiteUrl());
  url.searchParams.set('v', OG_IMAGE_VERSION);
  return url.toString();
};

type BuildAbsoluteUrlInput =
  | string
  | {
      pathname: string;
      query?: Record<string, string | number | boolean | undefined | null>;
    };

export const buildAbsoluteUrl = (input: BuildAbsoluteUrlInput) => {
  const siteUrl = getSiteUrl();
  const pathname = typeof input === 'string' ? input : input.pathname;
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, siteUrl);

  if (typeof input !== 'string' && input.query) {
    Object.entries(input.query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  return url.toString();
};

export const buildWebPageSchema = (name: string, description: string, pathname: string) => ({
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name,
  description,
  url: buildAbsoluteUrl(pathname)
});

export const buildBreadcrumbSchema = (items: Array<{ name: string; path: string }>) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map((item, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: item.name,
    item: buildAbsoluteUrl(item.path)
  }))
});

export const buildOrganizationSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'LLM Arena',
  url: getSiteUrl(),
  logo: buildAbsoluteUrl('/img/icon.svg')
});

export const buildWebsiteSchema = () => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'LLM Arena',
  url: getSiteUrl()
});

export const buildJobPostingSchema = (job: JobPosting) => {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description,
    datePosted: job.created_at.toISOString(),
    employmentType: job.employment_type.replace(/_/g, ' '),
    hiringOrganization: {
      '@type': 'Organization',
      name: 'LLM Arena',
      sameAs: getSiteUrl()
    },
    url: buildAbsoluteUrl(`/careers/${job.slug}`)
  };

  if (job.location_type === 'REMOTE') {
    schema.jobLocationType = 'TELECOMMUTE';
    schema.applicantLocationRequirements = {
      '@type': 'Country',
      name: 'United States'
    };
  } else if (job.location) {
    schema.jobLocation = {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: job.location
      }
    };
  }

  return schema;
};

export const buildSeo = (options: {
  title: string;
  description?: string;
  canonicalPath: string;
  robots?: string;
  ogType?: string;
  ogImagePath?: string;
  ogImageUrl?: string;
  twitterImageUrl?: string;
  ogImageAlt?: string;
  structuredData?: Record<string, unknown>[];
}) => ({
  title: options.title,
  description: options.description || DEFAULT_SEO_DESCRIPTION,
  canonicalPath: options.canonicalPath,
  canonicalUrl: buildAbsoluteUrl(options.canonicalPath),
  robots: options.robots,
  ogType: options.ogType || 'website',
  ogImage: withOgVersion(options.ogImageUrl || buildAbsoluteUrl(options.ogImagePath || DEFAULT_OG_IMAGE_PATH)),
  twitterImage: withOgVersion(options.twitterImageUrl || options.ogImageUrl || buildAbsoluteUrl(options.ogImagePath || DEFAULT_OG_IMAGE_PATH)),
  ogImageAlt: options.ogImageAlt || `${options.title} preview`,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/png',
  structuredData: options.structuredData || []
});

export const buildModelDescription = (model: Pick<Model, 'name' | 'description' | 'api_provider'>) =>
  model.description?.trim() ||
  `${model.name} is a registered ${model.api_provider} model available for public evaluation and replay tracking in LLM Arena.`;

export const buildMatchDescription = (match: {
  id: string;
  game_type: string;
  status: MatchStatus;
  participants?: Array<{ model: { name: string } }>;
}) => {
  const names = (match.participants || []).map(participant => participant.model.name).filter(Boolean);
  const matchup = names.length > 0 ? ` featuring ${names.join(' vs ')}` : '';
  return `Replay and audit trail for ${match.game_type.replace(/_/g, ' ')} match ${match.id}${matchup}. Current status: ${match.status}.`;
};
