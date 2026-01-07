import { SMSMessage } from './types';
import axios from 'axios';

export class MockSMSProvider {
    async send(msg: SMSMessage): Promise<void> {
        console.log(`[MOCK SMS] To: ${msg.to} | Message: ${msg.body}`);
    }
}

export class TwilioSMSProvider {
    private accountSid: string;
    private authToken: string;
    private fromNumber: string;

    constructor(sid: string, token: string, from: string) {
        this.accountSid = sid;
        this.authToken = token;
        this.fromNumber = from;
    }

    async send(msg: SMSMessage): Promise<void> {
        // Basic Twilio API call
        // Using axios to avoid adding 'twilio' SDK dependency if not strictly needed, 
        // but SDK is usually better. For "assume we are using Twilio", I'll implement the API call logic.
        // Or if the user hasn't npm installed twilio, this might fail type checks if I try to import it.
        // I'll use a direct API call or console log if creds are missing.
        
        try {
            const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
            const params = new URLSearchParams();
            params.append('To', msg.to);
            params.append('From', this.fromNumber);
            params.append('Body', msg.body);

            const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

            await axios.post(url, params, {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            console.log(`[TWILIO] Sent to ${msg.to}`);
        } catch (error: any) {
            console.error('[TWILIO ERROR]', error.response?.data || error.message);
            throw error;
        }
    }
}
