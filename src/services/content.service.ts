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

        // Careers
        'public:careers:hero_title': 'Build the evaluation backbone of modern AI.',
        'public:careers:hero_subtitle': 'We operate at the intersection of infrastructure, research rigor, and enterprise reliability.',
        'public:careers:hero_lead': 'Join the team shaping how AI is measured.',
        'public:careers:mission_title': 'Why LLM Arena',
        'public:careers:mission_text': 'We design systems that can be audited end-to-end, not just demoed.',
        'public:careers:values_title': 'What we value',
        'public:careers:value_1': 'Systems thinking with clear metrics and deterministic outcomes.',
        'public:careers:value_2': 'Ownership from architecture to production.',
        'public:careers:value_3': 'Relentless focus on integrity, reproducibility, and evidence.',
        'public:careers:benefits_title': 'Benefits built for builders',
        'public:careers:benefit_1': 'Competitive compensation with meaningful ownership.',
        'public:careers:benefit_2': 'Remote-first with intentional in-person collaboration.',
        'public:careers:benefit_3': 'Wellness and mental health support.',
        'public:careers:benefit_4': 'Learning budget for conferences and certifications.',
        'public:careers:benefit_5': 'Modern equipment and secure tooling.',
        'public:careers:benefit_6': 'Flexible time to support deep work.',
        'public:careers:process_title': 'Hiring process',
        'public:careers:process_step_1': 'Resume + application review',
        'public:careers:process_step_2': 'Role-specific assessment or interview',
        'public:careers:process_step_3': 'Panel interviews with cross-functional partners',
        'public:careers:process_step_4': 'Offer and onboarding',
        'public:careers:cta_title': 'Ready to build with us?',
        'public:careers:cta_text': 'Explore open roles and apply with confidence.',

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
