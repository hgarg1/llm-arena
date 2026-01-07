export interface EmailMessage {
    to: string;
    subject: string;
    body: string; // Plain text or HTML
    html?: string;
}

export interface SMSMessage {
    to: string; // E.164 format
    body: string;
}

export interface CommunicationProvider {
    sendEmail(msg: EmailMessage): Promise<void>;
    sendSMS(msg: SMSMessage): Promise<void>;
}
