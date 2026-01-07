import { Router } from 'express';
import { PublicController } from '../controllers/public/public.controller';
import * as careersController from '../controllers/careers.controller';

const router = Router();

router.get('/', PublicController.home);
router.get('/how-it-works', PublicController.howItWorks);
router.get('/benchmarks', PublicController.benchmarks);
router.get('/methodology', PublicController.methodology);
router.get('/use-cases', PublicController.useCases);
router.get('/about', PublicController.about);
router.get('/docs', PublicController.docs);
router.get('/terms', PublicController.terms);
router.get('/privacy', PublicController.privacy);
router.get('/sitemap.xml', PublicController.sitemap);
router.get('/careers', careersController.careersIndex);
router.get('/careers/:slug', careersController.careersDetail);
router.get('/careers/:slug/apply', careersController.applyStart);
router.post('/careers/:slug/apply/parse', careersController.resumeUpload, careersController.parseResume);
router.post('/careers/:slug/apply/submit', careersController.submitApplication);

export default router;
