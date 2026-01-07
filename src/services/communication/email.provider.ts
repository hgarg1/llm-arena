import { EmailMessage } from './types';

export class MockEmailProvider {
    async send(msg: EmailMessage): Promise<void> {
        console.log(`[MOCK EMAIL] To: ${msg.to} | Subject: ${msg.subject}`);
        console.log(`[MOCK EMAIL] Body: ${msg.body}`);
        if (msg.html) {
            // In a real mock, maybe save to a file to inspect? 
            // For console logs, just distinct it.
            console.log(`[MOCK EMAIL] HTML Content Present`);
        }
    }
}

// Extendable for SendGrid, AWS SES, SMTP, etc.
// export class SendGridEmailProvider { ... }
