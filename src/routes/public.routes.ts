import { Router } from 'express';
import { PublicController } from '../controllers/public/public.controller';

const router = Router();

router.get('/', PublicController.home);
router.get('/how-it-works', PublicController.howItWorks);
router.get('/benchmarks', PublicController.benchmarks);
router.get('/methodology', PublicController.methodology);
router.get('/use-cases', PublicController.useCases);
router.get('/about', PublicController.about);
router.get('/docs', PublicController.docs);
router.get('/sitemap.xml', PublicController.sitemap);

export default router;
