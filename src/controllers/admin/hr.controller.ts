import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { prisma } from '../../config/db';
import { logAdminAction } from '../../services/audit.service';
import { uploadToAzure } from '../../services/storage.service';
import archiver from 'archiver';
import { comms } from '../../services/communication';

const slugify = (value: string) => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};

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
  { key: 'work_auth', label: 'Work authorization status', type: 'SHORT_TEXT', required: false }
]);

const defaultRubric = () => ([
  { key: 'role_fit', label: 'Role fit', weight: 0.3, guidance: 'Depth of alignment with the role responsibilities.' },
  { key: 'technical_depth', label: 'Technical depth', weight: 0.25, guidance: 'Systems thinking, architecture, and execution quality.' },
  { key: 'impact', label: 'Impact', weight: 0.2, guidance: 'Evidence of measurable outcomes and ownership.' },
  { key: 'communication', label: 'Communication', weight: 0.15, guidance: 'Clarity, structure, and concise explanation.' },
  { key: 'leadership', label: 'Leadership', weight: 0.1, guidance: 'Collaboration, initiative, and decision-making.' }
]);

const allowedStatuses = ['NEW', 'IN_REVIEW', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'];

const formatIcsDate = (date: Date) => {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
};

export const hrDashboard = async (req: Request, res: Response) => {
  const [jobs, applications, statusBreakdown, scoreAverages, jobStats, scoreRows] = await Promise.all([
    prisma.jobPosting.count(),
    prisma.jobApplication.count(),
    prisma.jobApplication.groupBy({
      by: ['status'],
      _count: { _all: true }
    }),
    prisma.jobApplication.aggregate({
      _avg: { ai_fit_score: true, ai_sentiment_score: true, review_score: true }
    }),
    prisma.jobPosting.findMany({
      include: { _count: { select: { applications: true } } },
      orderBy: { created_at: 'desc' },
      take: 5
    }),
    prisma.jobApplication.findMany({
      select: {
        ai_fit_score: true,
        ai_sentiment_score: true,
        review_score: true,
        ai_sentiment_fit: true,
        ai_sentiment_application: true,
        job: { select: { id: true, title: true } }
      },
      orderBy: { created_at: 'desc' },
      take: 200
    })
  ]);
  const recentApps = await prisma.jobApplication.findMany({
    orderBy: { created_at: 'desc' },
    take: 6,
    include: { job: { select: { title: true } } }
  });
  const bucketRanges = [
    { label: '0-49', min: 0, max: 49.99 },
    { label: '50-69', min: 50, max: 69.99 },
    { label: '70-84', min: 70, max: 84.99 },
    { label: '85-100', min: 85, max: 100 }
  ];
  const scoreBuckets = {
    fit: bucketRanges.map(bucket => ({ ...bucket, count: 0 })),
    sentiment: bucketRanges.map(bucket => ({ ...bucket, count: 0 })),
    review: bucketRanges.map(bucket => ({ ...bucket, count: 0 }))
  };
  const signalCounts: Record<string, number> = {};
  const riskCounts: Record<string, number> = {};
  const roleMetrics = new Map<string, { title: string; count: number; fit: number; sentiment: number }>();
  const addSignals = (payload: any, key: string, target: Record<string, number>) => {
    const values = Array.isArray(payload?.[key]) ? payload[key] : [];
    values.forEach((item: string) => {
      const trimmed = String(item || '').trim();
      if (!trimmed) return;
      target[trimmed] = (target[trimmed] || 0) + 1;
    });
  };

  scoreRows.forEach(row => {
    const fit = typeof row.ai_fit_score === 'number' ? row.ai_fit_score : null;
    const sentiment = typeof row.ai_sentiment_score === 'number' ? row.ai_sentiment_score : null;
    const review = typeof row.review_score === 'number' ? row.review_score : null;
    if (fit !== null) {
      const bucket = scoreBuckets.fit.find(b => fit >= b.min && fit <= b.max);
      if (bucket) bucket.count += 1;
    }
    if (sentiment !== null) {
      const bucket = scoreBuckets.sentiment.find(b => sentiment >= b.min && sentiment <= b.max);
      if (bucket) bucket.count += 1;
    }
    if (review !== null) {
      const bucket = scoreBuckets.review.find(b => review >= b.min && review <= b.max);
      if (bucket) bucket.count += 1;
    }

    if (row.job?.id) {
      const current = roleMetrics.get(row.job.id) || { title: row.job.title, count: 0, fit: 0, sentiment: 0 };
      current.count += 1;
      if (fit !== null) current.fit += fit;
      if (sentiment !== null) current.sentiment += sentiment;
      roleMetrics.set(row.job.id, current);
    }

    addSignals(row.ai_sentiment_fit, 'signals', signalCounts);
    addSignals(row.ai_sentiment_fit, 'gaps', riskCounts);
    addSignals(row.ai_sentiment_application, 'risks', riskCounts);
  });

  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));
  const topRisks = Object.entries(riskCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));
  const roleScoreCards = Array.from(roleMetrics.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(metric => ({
      title: metric.title,
      count: metric.count,
      fitAvg: metric.count ? metric.fit / metric.count : null,
      sentimentAvg: metric.count ? metric.sentiment / metric.count : null
    }));
  const scoreSample = scoreRows.length || 1;
  res.render('admin/hr/dashboard', {
    title: 'HR',
    path: '/admin/hr',
    stats: { jobs, applications },
    breakdown: statusBreakdown,
    averages: scoreAverages,
    jobStats,
    recentApps,
    scoreBuckets,
    topSignals,
    topRisks,
    roleScoreCards,
    scoreSample
  });
};

export const jobsList = async (req: Request, res: Response) => {
  const jobs = await prisma.jobPosting.findMany({
    orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
    include: { _count: { select: { applications: true } } }
  });
  res.render('admin/hr/jobs/index', {
    title: 'HR Jobs',
    path: '/admin/hr/jobs',
    jobs,
    success: req.query.success,
    error: req.query.error
  });
};

export const newJobPage = async (req: Request, res: Response) => {
  res.render('admin/hr/jobs/new', {
    title: 'New Job',
    path: '/admin/hr/jobs',
    questions: JSON.stringify(defaultQuestions(), null, 2),
    rubric: JSON.stringify(defaultRubric(), null, 2)
  });
};

export const createJob = async (req: Request, res: Response) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const summary = (req.body.summary || '').trim();
  const slug = (req.body.slug || slugify(title)).trim();
  const status = (req.body.status || 'DRAFT').toUpperCase();

  if (!title || !summary || !description) {
    return res.redirect('/admin/hr/jobs?error=Title, summary, and description are required');
  }

  let schema: any = null;
  if (req.body.application_schema) {
    try {
      schema = JSON.parse(req.body.application_schema);
    } catch (err) {
      return res.redirect('/admin/hr/jobs?error=Application schema must be valid JSON');
    }
  }
  let rubric: any = null;
  if (req.body.review_rubric) {
    try {
      rubric = JSON.parse(req.body.review_rubric);
    } catch (err) {
      return res.redirect('/admin/hr/jobs?error=Review rubric must be valid JSON');
    }
  }

  const job = await prisma.jobPosting.create({
    data: {
      title,
      summary,
      description,
      slug,
      location: req.body.location || null,
      location_type: req.body.location_type || 'REMOTE',
      employment_type: req.body.employment_type || 'FULL_TIME',
      department: req.body.department || null,
      seniority: req.body.seniority || null,
      status: status as any,
      featured: req.body.featured === 'on',
      application_schema: schema || defaultQuestions(),
      review_rubric: rubric || defaultRubric(),
      created_by: (req.session as any).userId
    }
  });
  await logAdminAction((req.session as any).userId, 'hr.job.create', job.id, { title: job.title });
  res.redirect('/admin/hr/jobs?success=Job created');
};

export const editJobPage = async (req: Request, res: Response) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!job) return res.redirect('/admin/hr/jobs?error=Job not found');
  res.render('admin/hr/jobs/edit', {
    title: `Edit ${job.title}`,
    path: '/admin/hr/jobs',
    job,
    questions: JSON.stringify(job.application_schema || defaultQuestions(), null, 2),
    rubric: JSON.stringify(job.review_rubric || defaultRubric(), null, 2)
  });
};

export const updateJob = async (req: Request, res: Response) => {
  const { id } = req.params;
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const summary = (req.body.summary || '').trim();
  const slug = (req.body.slug || slugify(title)).trim();
  const status = (req.body.status || 'DRAFT').toUpperCase();

  if (!title || !summary || !description) {
    return res.redirect('/admin/hr/jobs?error=Title, summary, and description are required');
  }

  let schema: any = null;
  if (req.body.application_schema) {
    try {
      schema = JSON.parse(req.body.application_schema);
    } catch (err) {
      return res.redirect('/admin/hr/jobs?error=Application schema must be valid JSON');
    }
  }
  let rubric: any = null;
  if (req.body.review_rubric) {
    try {
      rubric = JSON.parse(req.body.review_rubric);
    } catch (err) {
      return res.redirect('/admin/hr/jobs?error=Review rubric must be valid JSON');
    }
  }

  await prisma.jobPosting.update({
    where: { id },
    data: {
      title,
      summary,
      description,
      slug,
      location: req.body.location || null,
      location_type: req.body.location_type || 'REMOTE',
      employment_type: req.body.employment_type || 'FULL_TIME',
      department: req.body.department || null,
      seniority: req.body.seniority || null,
      status: status as any,
      featured: req.body.featured === 'on',
      application_schema: schema || defaultQuestions(),
      review_rubric: rubric || defaultRubric()
    }
  });
  await logAdminAction((req.session as any).userId, 'hr.job.update', id, { title });
  res.redirect('/admin/hr/jobs?success=Job updated');
};

export const applicationsList = async (req: Request, res: Response) => {
  const status = String(req.query.status || '').trim();
  const jobId = String(req.query.job || '').trim();
  const q = String(req.query.q || '').trim();
  const minFitRaw = req.query.min_fit ? parseFloat(String(req.query.min_fit)) : null;
  const minSentimentRaw = req.query.min_sentiment ? parseFloat(String(req.query.min_sentiment)) : null;
  const minReviewRaw = req.query.min_review ? parseFloat(String(req.query.min_review)) : null;
  const interviewStatus = String(req.query.interview_status || '').trim();
  const where: any = {};
  if (status) where.status = status;
  if (jobId) where.job_id = jobId;
  if (interviewStatus) where.interview_status = interviewStatus;
  if (q) {
    where.OR = [
      { full_name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } }
    ];
  }
  const [_applications, jobs, averages] = await Promise.all([
    prisma.jobApplication.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { job: true }
    }),
    prisma.jobPosting.findMany({ orderBy: { title: 'asc' } }),
    prisma.jobApplication.aggregate({
      _avg: { ai_fit_score: true, ai_sentiment_score: true, review_score: true }
    })
  ]);
  const minFit = minFitRaw !== null && !Number.isNaN(minFitRaw)
    ? minFitRaw
    : (averages._avg.ai_fit_score ?? null);
  const minSentiment = minSentimentRaw !== null && !Number.isNaN(minSentimentRaw)
    ? minSentimentRaw
    : (averages._avg.ai_sentiment_score ?? null);
  const minReview = minReviewRaw !== null && !Number.isNaN(minReviewRaw)
    ? minReviewRaw
    : (averages._avg.review_score ?? null);
  if (minFit !== null) {
    where.ai_fit_score = { gte: minFit };
  }
  if (minSentiment !== null) {
    where.ai_sentiment_score = { gte: minSentiment };
  }
  if (minReview !== null) {
    where.review_score = { gte: minReview };
  }
  const filteredApplications = await prisma.jobApplication.findMany({
    where,
    orderBy: { created_at: 'desc' },
    include: { job: true }
  });
  res.render('admin/hr/applications/index', {
    title: 'HR Applications',
    path: '/admin/hr/applications',
    applications: filteredApplications,
    jobs,
    query: req.query,
    averages
  });
};

export const applicationDetail = async (req: Request, res: Response) => {
  const application = await prisma.jobApplication.findUnique({
    where: { id: req.params.id },
    include: { job: true, answers: true }
  });
  if (!application) return res.redirect('/admin/hr/applications?error=Application not found');
  const rubric = Array.isArray(application.job.review_rubric) ? application.job.review_rubric : defaultRubric();
  const scoredRubric = Array.isArray(application.review_rubric) ? application.review_rubric : rubric;
  res.render('admin/hr/applications/detail', {
    title: application.full_name,
    path: '/admin/hr/applications',
    application,
    rubric: scoredRubric
  });
};

export const updateApplicationStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const status = (req.body.status || '').toUpperCase();
  const adminNotes = (req.body.admin_notes || '').trim();
  const notifyEmail = req.body.notify_email === 'on';
  const notifySms = req.body.notify_sms === 'on';
  const message = (req.body.message || '').trim();
  if (!allowedStatuses.includes(status)) {
    return res.redirect(`/admin/hr/applications/${id}?error=Invalid status`);
  }
  const application = await prisma.jobApplication.findUnique({
    where: { id },
    include: { job: true }
  });
  if (!application) return res.redirect('/admin/hr/applications?error=Application not found');
  await prisma.jobApplication.update({
    where: { id },
    data: {
      status: status as any,
      admin_notes: adminNotes || null,
      last_contacted_at: notifyEmail || notifySms ? new Date() : undefined
    }
  });
  if (notifyEmail && application.email) {
    const subject = `Update on your ${application.job.title} application`;
    const body = message || `Thanks for applying to LLM Arena. Your application status is now ${status}.`;
    await comms.sendEmail(application.email, subject, body);
  }
  if (notifySms && application.phone) {
    const body = message || `LLM Arena update: your ${application.job.title} application status is now ${status}.`;
    await comms.sendSMS(application.phone, body);
  }
  await logAdminAction((req.session as any).userId, 'hr.application.update', id, { status });
  res.redirect(`/admin/hr/applications/${id}?success=Application updated`);
};

export const updateApplicationReview = async (req: Request, res: Response) => {
  const { id } = req.params;
  const application = await prisma.jobApplication.findUnique({
    where: { id },
    include: { job: true }
  });
  if (!application) return res.redirect('/admin/hr/applications?error=Application not found');
  const rubric = Array.isArray(application.job.review_rubric) ? application.job.review_rubric : defaultRubric();
  const scoredRubric = rubric.map((item: any) => {
    const key = String(item.key || '');
    const raw = req.body[`rubric_${key}`];
    const score = raw ? parseFloat(raw) : null;
    return { ...item, score: Number.isFinite(score) ? score : null };
  });
  const totalWeight = scoredRubric.reduce((sum: number, item: any) => sum + (typeof item.weight === 'number' ? item.weight : 0), 0) || 1;
  const weighted = scoredRubric.reduce((sum: number, item: any) => {
    const weight = typeof item.weight === 'number' ? item.weight : 0;
    const score = typeof item.score === 'number' ? item.score : 0;
    return sum + ((score / 5) * weight);
  }, 0);
  const reviewScore = Math.round(((weighted / totalWeight) * 100) * 10) / 10;
  await prisma.jobApplication.update({
    where: { id },
    data: {
      review_rubric: scoredRubric,
      review_score: Number.isFinite(reviewScore) ? reviewScore : null
    }
  });
  await logAdminAction((req.session as any).userId, 'hr.application.review', id, { reviewScore });
  res.redirect(`/admin/hr/applications/${id}?success=Review saved`);
};

export const scheduleInterview = async (req: Request, res: Response) => {
  const { id } = req.params;
  const scheduledAt = req.body.scheduled_at ? new Date(req.body.scheduled_at) : null;
  const location = (req.body.location || '').trim();
  const notes = (req.body.notes || '').trim();
  const notifyEmail = req.body.notify_email === 'on';
  const notifySms = req.body.notify_sms === 'on';

  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    return res.redirect(`/admin/hr/applications/${id}?error=Interview date required`);
  }

  const application = await prisma.jobApplication.findUnique({
    where: { id },
    include: { job: true }
  });
  if (!application) return res.redirect('/admin/hr/applications?error=Application not found');

  await prisma.jobApplication.update({
    where: { id },
    data: {
      interview_status: 'SCHEDULED',
      interview_scheduled_at: scheduledAt,
      interview_location: location || null,
      interview_notes: notes || null,
      status: application.status === 'NEW' ? 'INTERVIEW' : application.status,
      last_contacted_at: notifyEmail || notifySms ? new Date() : application.last_contacted_at
    }
  });

  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const icsBody = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LLM Arena//HR//EN',
    'BEGIN:VEVENT',
    `UID:${application.id}@llmarena.com`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(scheduledAt)}`,
    `DTEND:${formatIcsDate(new Date(scheduledAt.getTime() + 60 * 60 * 1000))}`,
    `SUMMARY:Interview - ${application.job.title}`,
    location ? `LOCATION:${location}` : '',
    notes ? `DESCRIPTION:${notes}` : '',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  const calendarDir = path.join(process.cwd(), 'public', 'uploads', 'interviews');
  await fs.mkdir(calendarDir, { recursive: true });
  const calendarPath = path.join(calendarDir, `${application.id}.ics`);
  await fs.writeFile(calendarPath, icsBody);
  const calendarLink = `${appUrl}/uploads/interviews/${application.id}.ics`;

  if (notifyEmail && application.email) {
    const subject = `Interview scheduled for ${application.job.title}`;
    const body = [
      `Hi ${application.full_name},`,
      '',
      `Your interview for ${application.job.title} is scheduled for ${scheduledAt.toLocaleString()}.`,
      location ? `Location: ${location}` : '',
      notes ? `Notes: ${notes}` : '',
      `Calendar invite: ${calendarLink}`,
      '',
      'Reply to this email if you need to reschedule.'
    ].filter(Boolean).join('\n');
    await comms.sendEmail(application.email, subject, body);
  }
  if (notifySms && application.phone) {
    const body = `LLM Arena interview scheduled: ${scheduledAt.toLocaleString()} ${location ? `@ ${location}` : ''}`.trim();
    await comms.sendSMS(application.phone, body);
  }

  await logAdminAction((req.session as any).userId, 'hr.application.schedule', id, { scheduledAt, location });
  res.redirect(`/admin/hr/applications/${id}?success=Interview scheduled`);
};

export const bulkUpdateApplications = async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body.application_ids)
    ? req.body.application_ids
    : req.body.application_ids
      ? [req.body.application_ids]
      : [];
  const action = String(req.body.action || '').trim();
  const status = String(req.body.status || '').trim().toUpperCase();
  const message = String(req.body.message || '').trim();
  const notifyEmail = req.body.notify_email === 'on';
  const notifySms = req.body.notify_sms === 'on';

  if (!ids.length) return res.redirect('/admin/hr/applications?error=Select at least one application');

  const applications = await prisma.jobApplication.findMany({
    where: { id: { in: ids } },
    include: { job: true }
  });

  if (action === 'set_status') {
    if (!allowedStatuses.includes(status)) return res.redirect('/admin/hr/applications?error=Select a valid status');
    await prisma.jobApplication.updateMany({
      where: { id: { in: ids } },
      data: {
        status: status as any,
        last_contacted_at: notifyEmail || notifySms ? new Date() : undefined
      }
    });

    if (notifyEmail || notifySms) {
      for (const application of applications) {
        if (notifyEmail && application.email) {
          const subject = `Update on your ${application.job.title} application`;
          const body = message || `Thanks for applying to LLM Arena. Your application status is now ${status}.`;
          await comms.sendEmail(application.email, subject, body);
        }
        if (notifySms && application.phone) {
          const body = message || `LLM Arena update: your ${application.job.title} application status is now ${status}.`;
          await comms.sendSMS(application.phone, body);
        }
      }
    }
    await logAdminAction((req.session as any).userId, 'hr.application.bulk_status', 'bulk', { status, count: ids.length });
    return res.redirect('/admin/hr/applications?success=Applications updated');
  }

  if (action === 'send_update') {
    if (!message) return res.redirect('/admin/hr/applications?error=Message required');
    for (const application of applications) {
      if (notifyEmail && application.email) {
        await comms.sendEmail(application.email, `Update on ${application.job.title}`, message);
      }
      if (notifySms && application.phone) {
        await comms.sendSMS(application.phone, message);
      }
    }
    await prisma.jobApplication.updateMany({
      where: { id: { in: ids } },
      data: { last_contacted_at: new Date() }
    });
    await logAdminAction((req.session as any).userId, 'hr.application.bulk_message', 'bulk', { count: ids.length });
    return res.redirect('/admin/hr/applications?success=Updates sent');
  }

  res.redirect('/admin/hr/applications?error=Unsupported bulk action');
};

export const compileResumes = async (req: Request, res: Response) => {
  const jobId = req.params.id;
  const applications = await prisma.jobApplication.findMany({
    where: { job_id: jobId, resume_path: { not: null } }
  });
  const folderName = `uploads/resumes/compiled/${jobId}-${Date.now()}`;
  const targetDir = path.join(process.cwd(), 'public', folderName);
  await fs.mkdir(targetDir, { recursive: true });

  for (const app of applications) {
    if (!app.resume_path) continue;
    const safePath = app.resume_path.replace(/^\//, '');
    const source = path.join(process.cwd(), 'public', safePath);
    const fileName = `${app.full_name.replace(/[^a-zA-Z0-9._-]/g, '_')}_${path.basename(app.resume_path)}`;
    await fs.copyFile(source, path.join(targetDir, fileName));
  }

  const manifest = {
    jobId,
    generatedAt: new Date().toISOString(),
    count: applications.length
  };
  await fs.writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const zipPath = path.join(targetDir, 'resumes.zip');
  await new Promise<void>((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve());
    archive.on('error', (err: Error) => reject(err));
    archive.pipe(output);
    archive.directory(targetDir, false, (entry: any) => {
      if (entry.name === 'resumes.zip') return false;
      return entry;
    });
    archive.finalize();
  });

  const zipBuffer = await fs.readFile(zipPath);
  const blobUrl = await uploadToAzure(zipBuffer, `compiled/${jobId}-resumes.zip`, 'uploads/resumes');

  await logAdminAction((req.session as any).userId, 'hr.resume.compile', jobId, { folder: folderName, blobUrl });
  res.redirect(`/admin/hr/jobs?success=Resumes compiled`);
};
