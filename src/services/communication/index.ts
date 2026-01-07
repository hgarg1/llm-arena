import { EmailMessage, SMSMessage } from './types';
import { MockEmailProvider } from './email.provider';
import { MockSMSProvider, TwilioSMSProvider } from './sms.provider';
import { settingsService } from '../settings.service';

class CommunicationService {
    private emailProvider: any;
    private smsProvider: any;
    private twilioProvider: any;

    constructor() {
        // Initialize Providers based on ENV
        this.emailProvider = new MockEmailProvider();

        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
            this.twilioProvider = new TwilioSMSProvider(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN,
                process.env.TWILIO_FROM_NUMBER
            );
        }

        this.smsProvider = new MockSMSProvider();
    }

    async sendEmail(to: string, subject: string, body: string, html?: string) {
        const settings = await settingsService.getAll();
        if (settings.comms_email_enabled === 'false') {
            console.log('[COMMS] Email disabled, skipping send.');
            return;
        }
        await this.emailProvider.send({ to, subject, body, html });
    }

    async sendSMS(to: string, body: string) {
        const settings = await settingsService.getAll();
        if (settings.comms_sms_enabled === 'false') {
            console.log('[COMMS] SMS disabled, skipping send.');
            return;
        }

        const provider = settings.comms_sms_provider || 'auto';
        const smsProvider = provider === 'twilio' ? this.twilioProvider : provider === 'mock' ? this.smsProvider : (this.twilioProvider || this.smsProvider);
        if (!smsProvider) {
            console.log('[COMMS] SMS provider unavailable, skipping send.');
            return;
        }
        await smsProvider.send({ to, body });
    }
}

export const comms = new CommunicationService();
