import { Router } from 'express';
import { InvestorController } from '../controllers/investor.controller';

const router = Router();

router.get('/', InvestorController.home);
router.get('/financials', InvestorController.financials);
router.get('/press', InvestorController.press);
router.get('/filings', InvestorController.filings);
router.get('/faq', InvestorController.faq);
router.get('/contact', InvestorController.contact);

// Governance
router.get('/governance/board', InvestorController.board);
router.get('/governance/executives', InvestorController.executives);
router.get('/governance/committees', InvestorController.committees);
router.get('/governance/documents', InvestorController.documents);

export default router;
