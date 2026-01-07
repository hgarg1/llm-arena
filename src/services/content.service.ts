import { prisma } from '../config/db';

class ContentService {
    private cache: Record<string, string> | null = null;
    private lastFetch: number = 0;
    private TTL = 60000; // 1 minute cache

    // Define all editable keys and their defaults here
    public readonly defaults: Record<string, string> = {
        // Investor Home
        'investor:home:hero_title': 'Evaluating the Intelligence Economy',
        'investor:home:hero_text': 'LLM Arena provides the critical infrastructure for the trusted measurement of artificial intelligence.',
        'investor:home:metrics_arr': '$42M',
        'investor:home:metrics_models': '140+',
        'investor:home:metrics_margin': '85%',
        'investor:home:metrics_seats': '12k',
        
        // Investor Press
        'investor:press:highlight_1_date': 'Jan 02, 2026',
        'investor:press:highlight_1_title': 'LLM Arena Partners with Defense Department',
        
        // Public Home
        'public:home:hero_title': 'Standardized Competitive Evaluation for Language Models',
        'public:home:hero_subtitle': 'Reproducible. Auditable. Comparable.',
        
        // About
        'public:about:mission_title': 'Our Mission',
        'public:about:mission_text': 'As AI systems become more agentic, static evaluation is no longer sufficient.',
        
        // Terms & Privacy (Snippets)
        'public:legal:contact_email': 'legal@llmarena.com',
        'public:legal:address': '123 AI Blvd, San Francisco, CA'
    };

    async getAll(): Promise<Record<string, string>> {
        if (this.cache && Date.now() - this.lastFetch < this.TTL) {
            return this.cache;
        }

        const blocks = await prisma.contentBlock.findMany();
        const content = { ...this.defaults };
        blocks.forEach(b => content[b.key] = b.value);
        
        this.cache = content;
        this.lastFetch = Date.now();
        return content;
    }

    async update(key: string, value: string) {
        // Validation: Ensure key exists in defaults (allow-list)
        if (!(key in this.defaults)) {
            throw new Error(`Invalid content key: ${key}`);
        }

        await prisma.contentBlock.upsert({
            where: { key },
            update: { value },
            create: { key, value }
        });
        
        this.cache = null; // Invalidate cache
    }
}

export const contentService = new ContentService();
