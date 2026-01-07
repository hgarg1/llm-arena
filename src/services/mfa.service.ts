import { authenticator } from 'otplib';
import QRCode from 'qrcode';

export class MfaService {
    generateSecret(email: string) {
        const secret = authenticator.generateSecret();
        // Standard keyuri: otpauth://totp/LLM%20Arena:email?secret=...&issuer=LLM%20Arena
        let otpauth = authenticator.keyuri(email, 'LLM Arena', secret);
        
        // Append image parameter for apps that support it (e.g. FreeOTP, some versions of Authy)
        // Note: Google Authenticator mostly ignores this and uses its own logo DB based on Issuer.
        // We use a high-quality logo URL. Since we are local, we'll use a placeholder from a CDN or similar.
        const logoUrl = 'https://cdn-icons-png.flaticon.com/512/2092/2092663.png'; // Generic Shield/AI Icon
        otpauth += `&image=${encodeURIComponent(logoUrl)}`;
        
        return { secret, otpauth };
    }

    async generateQRCode(otpauth: string) {
        return QRCode.toDataURL(otpauth);
    }

    verifyToken(token: string, secret: string) {
        return authenticator.verify({ token, secret });
    }

    generateBackupCodes() {
        return Array.from({ length: 10 }, () => Math.random().toString(36).substr(2, 10).toUpperCase());
    }
}

export const mfaService = new MfaService();
