import { Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../config/db';
import { analyzeApplicationSentiment, analyzeFitToRole, extractApplicationData } from '../services/hr-ai.service';
import { extractResumeText } from '../services/resume.service';
import {
  buildAbsoluteUrl,
  buildBreadcrumbSchema,
  buildJobPostingSchema,
  buildSeo,
  buildWebPageSchema
} from '../services/seo.service';
import { renderOgImage } from '../services/og-image.service';
import { persistUploadedFile, removeTempFile, writeTempFile } from '../services/storage.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
export const resumeUpload = upload.single('resume');

const defaultQuestions = () => ([
  { key: 'motivation', label: 'Why LLM Arena and why this role?', type: 'LONG_TEXT', required: true },
  { key: 'impact', label: 'Describe a project that moved a metric or business outcome.', type: 'LONG_TEXT', required: true },
  { key: 'systems', label: 'Explain a hard systems problem you solved and how you validated it.', type: 'LONG_TEXT', required: true },
  { key: 'ai_experience', label: 'Describe your experience with LLM/AI systems and evaluation.', type: 'LONG_TEXT', required: true },
  { key: 'ownership', label: 'Give an example of shipping under ambiguity. What did you decide?', type: 'LONG_TEXT', required: true },
  { key: 'failure', label: 'Share a meaningful failure and what you learned.', type: 'LONG_TEXT', required: true },
  { key: 'security', label: 'How do you approach security, privacy, and compliance in your work?', type: 'LONG_TEXT', required: true },
  { key: 'collaboration', label: 'Describe a cross-functional conflict you resolved.', type: 'LONG_TEXT', required: true },
  { key: 'metrics', label: 'Which metrics do you use to know a system is healthy?', type: 'LONG_TEXT', required: true },
  { key: 'tradeoffs', label: 'Walk through a tradeoff you made between speed, quality, and cost.', type: 'LONG_TEXT', required: true },
  { key: 'salary', label: 'Desired salary range', type: 'SHORT_TEXT', required: false },
  { key: 'start_date', label: 'Earliest start date', type: 'SHORT_TEXT', required: false },
  { key: 'work_auth', label: 'Work authorization status', type: 'SHORT_TEXT', required: false },
  { key: 'relocation', label: 'Open to relocation?', type: 'BOOLEAN', required: false }
]);

const buildCareerBreadcrumbs = (current: { name: string; path: string }) => [
  { name: 'Home', path: '/' },
  { name: 'Careers', path: '/careers' },
  current
];

export const careersIndex = async (req: Request, res: Response) => {
  const jobs = await prisma.jobPosting.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ featured: 'desc' }, { created_at: 'desc' }]
  });
  const description = 'Explore open roles at LLM Arena across engineering, product, and operations.';
  res.render('public/careers/index', {
    title: 'Careers',
    seo: buildSeo({
      title: 'Careers',
      description,
      canonicalPath: '/careers',
      ogImageUrl: buildAbsoluteUrl('/og/page/careers.png'),
      structuredData: [
        buildWebPageSchema('Careers', description, '/careers'),
        buildBreadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Careers', path: '/careers' }
        ])
      ]
    }),
    path: '/careers',
    jobs
  });
};

export const careersDetail = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');
  const canonicalPath = `/careers/${job.slug}`;
  res.render('public/careers/detail', {
    title: job.title,
    seo: buildSeo({
      title: job.title,
      description: job.summary,
      canonicalPath,
      ogImageUrl: buildAbsoluteUrl(`/og/careers/${job.slug}.png`),
      structuredData: [
        buildWebPageSchema(job.title, job.summary, canonicalPath),
        buildBreadcrumbSchema(buildCareerBreadcrumbs({ name: job.title, path: canonicalPath })),
        buildJobPostingSchema(job)
      ]
    }),
    path: '/careers',
    job
  });
};

export const applyStart = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');
  const canonicalPath = `/careers/${job.slug}/apply`;
  res.render('public/careers/apply-step1', {
    title: `Apply - ${job.title}`,
    seo: buildSeo({
      title: `Apply - ${job.title}`,
      description: `Apply for ${job.title} at LLM Arena.`,
      canonicalPath,
      robots: 'noindex,follow'
    }),
    path: canonicalPath,
    job,
    error: req.query.error
  });
};

export const parseResume = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');
  if (!req.file) return res.redirect(`/careers/${job.slug}/apply?error=Resume required`);

  const fileName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '')}`;
  const folder = 'uploads/resumes';
  const persisted = await persistUploadedFile(req.file.buffer, fileName, folder, req.file.mimetype);
  const tempPath = await writeTempFile(req.file.buffer, fileName);
  const resumeText = await extractResumeText(tempPath, req.file.mimetype);
  await removeTempFile(tempPath);
  const aiExtract = await extractApplicationData(resumeText);

  (req.session as any).careersDraft = {
    jobId: job.id,
    resumePath: persisted.publicUrl,
    resumeBlobUrl: persisted.storage === 'azure' ? persisted.publicUrl : null,
    resumeText,
    aiExtract
  };

  const rawSchema = job.application_schema;
  const questions = Array.isArray(rawSchema) ? rawSchema : defaultQuestions();
  const canonicalPath = `/careers/${job.slug}/apply`;
  res.render('public/careers/apply-step2', {
    title: `Apply - ${job.title}`,
    seo: buildSeo({
      title: `Apply - ${job.title}`,
      description: `Continue your application for ${job.title} at LLM Arena.`,
      canonicalPath,
      robots: 'noindex,follow'
    }),
    path: canonicalPath,
    job,
    questions,
    prefill: aiExtract || {},
    error: null
  });
};

export const submitApplication = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');

  const draft = (req.session as any).careersDraft || {};
  if (draft.jobId !== job.id) {
    return res.redirect(`/careers/${job.slug}/apply?error=Please upload your resume again`);
  }

  const rawSchema = job.application_schema;
  const questions = Array.isArray(rawSchema) ? rawSchema : defaultQuestions();
  const answers = questions.map((question: any) => ({
    question_key: question.key,
    question_label: question.label,
    response: req.body[question.key] || null
  }));

  const application = await prisma.jobApplication.create({
    data: {
      job_id: job.id,
      full_name: req.body.full_name || draft.aiExtract?.full_name || 'Applicant',
      email: req.body.email || draft.aiExtract?.email || '',
      phone: req.body.phone || draft.aiExtract?.phone || null,
      location: req.body.location || draft.aiExtract?.location || null,
      linkedin_url: req.body.linkedin_url || draft.aiExtract?.linkedin_url || null,
      github_url: req.body.github_url || draft.aiExtract?.github_url || null,
      portfolio_url: req.body.portfolio_url || draft.aiExtract?.portfolio_url || null,
      resume_path: draft.resumePath,
      resume_blob_url: draft.resumeBlobUrl,
      resume_text: draft.resumeText,
      ai_extract: draft.aiExtract || null,
      source: req.body.source || 'careers'
    }
  });

  await prisma.jobApplicationAnswer.createMany({
    data: answers.map((answer: any) => ({
      application_id: application.id,
      question_key: answer.question_key,
      question_label: answer.question_label,
      response: answer.response
    }))
  });

  const applicationPayload = JSON.stringify({
    full_name: application.full_name,
    email: application.email,
    resume: draft.resumeText?.slice(0, 4000),
    answers
  });

  const sentiment = await analyzeApplicationSentiment(job.description, applicationPayload);
  const fit = await analyzeFitToRole(job.description, applicationPayload);

  await prisma.jobApplication.update({
    where: { id: application.id },
    data: {
      ai_sentiment_application: sentiment || null,
      ai_sentiment_fit: fit || null,
      ai_sentiment_score: sentiment?.score || null,
      ai_fit_score: fit?.score || null
    }
  });

  delete (req.session as any).careersDraft;
  const canonicalPath = `/careers/${job.slug}/apply`;
  res.render('public/careers/apply-step1', {
    title: `Apply - ${job.title}`,
    seo: buildSeo({
      title: `Apply - ${job.title}`,
      description: `Apply for ${job.title} at LLM Arena.`,
      canonicalPath,
      robots: 'noindex,follow'
    }),
    path: canonicalPath,
    job,
    error: null,
    success: 'Application submitted. Thank you.'
  });
};

export const ogImage = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).end();

  const chips = [job.department, job.location_type.replace(/_/g, ' '), job.employment_type.replace(/_/g, ' ')]
    .filter(Boolean)
    .slice(0, 3) as string[];

  const png = renderOgImage({
    theme: 'careers',
    eyebrow: 'Careers',
    title: job.title,
    description: job.summary,
    chips,
    metricLabel: 'Hiring',
    metricValue: job.featured ? 'Featured role' : 'Open role',
    footerLeft: job.location || job.location_type.replace(/_/g, ' '),
    footerRight: 'Apply on LLM Arena'
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(png);
};
