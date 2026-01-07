import { Request, Response } from 'express';

export class InvestorController {
    static async home(req: Request, res: Response) {
        res.render('investors/home', { title: 'Investor Relations', path: '/investors' });
    }

    static async financials(req: Request, res: Response) {
        res.render('investors/financials', { title: 'Financial Reports', path: '/investors/financials' });
    }

    static async press(req: Request, res: Response) {
        res.render('investors/press', { title: 'Press Releases', path: '/investors/press' });
    }

    static async filings(req: Request, res: Response) {
        res.render('investors/filings', { title: 'SEC Filings', path: '/investors/filings' });
    }

    static async faq(req: Request, res: Response) {
        res.render('investors/faq', { title: 'Investor FAQs', path: '/investors/faq' });
    }

    static async contact(req: Request, res: Response) {
        res.render('investors/contact', { title: 'IR Contact', path: '/investors/contact' });
    }

    static async board(req: Request, res: Response) {
        res.render('investors/governance/board', { title: 'Board of Directors', path: '/investors/governance' });
    }

    static async executives(req: Request, res: Response) {
        res.render('investors/governance/executives', { title: 'Executive Team', path: '/investors/governance' });
    }

    static async committees(req: Request, res: Response) {
        res.render('investors/governance/committees', { title: 'Committee Composition', path: '/investors/governance' });
    }

    static async documents(req: Request, res: Response) {
        res.render('investors/governance/documents', { title: 'Governance Documents', path: '/investors/governance' });
    }
}
