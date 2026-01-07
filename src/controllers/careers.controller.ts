import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import { prisma } from '../config/db';
import { extractResumeText } from '../services/resume.service';
import { uploadToAzure } from '../services/storage.service';
import { analyzeApplicationSentiment, analyzeFitToRole, extractApplicationData } from '../services/hr-ai.service';

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

export const careersIndex = async (req: Request, res: Response) => {
  const jobs = await prisma.jobPosting.findMany({
    where: { status: 'PUBLISHED' },
    orderBy: [{ featured: 'desc' }, { created_at: 'desc' }]
  });
  res.render('public/careers/index', {
    title: 'Careers',
    path: '/careers',
    jobs
  });
};

export const careersDetail = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');
  res.render('public/careers/detail', {
    title: job.title,
    path: '/careers',
    job
  });
};

export const applyStart = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findFirst({
    where: { slug: req.params.slug, status: 'PUBLISHED' }
  });
  if (!job) return res.status(404).render('errors/404');
  res.render('public/careers/apply-step1', {
    title: `Apply - ${job.title}`,
    path: '/careers',
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
  const localPath = path.join(process.cwd(), 'public', folder, fileName);
  await fs.mkdir(path.join(process.cwd(), 'public', folder), { recursive: true });
  await fs.writeFile(localPath, req.file.buffer);

  const resumeText = await extractResumeText(localPath, req.file.mimetype);
  const aiExtract = await extractApplicationData(resumeText);
  const blobUrl = await uploadToAzure(req.file.buffer, fileName, folder);

  (req.session as any).careersDraft = {
    jobId: job.id,
    resumePath: `/${folder}/${fileName}`,
    resumeBlobUrl: blobUrl,
    resumeText,
    aiExtract
  };

  const rawSchema = job.application_schema;
  const questions = Array.isArray(rawSchema) ? rawSchema : defaultQuestions();
  res.render('public/careers/apply-step2', {
    title: `Apply - ${job.title}`,
    path: '/careers',
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
  res.render('public/careers/apply-step1', {
    title: `Apply - ${job.title}`,
    path: '/careers',
    job,
    error: null,
    success: 'Application submitted. Thank you.'
  });
};
