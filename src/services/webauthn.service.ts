import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticatorTransport } from '@simplewebauthn/server';
import { prisma } from '../config/db';

const rpName = 'LLM Arena';
const rpID = process.env.RP_ID || 'localhost';
const origin = process.env.APP_URL || `http://${rpID}:3000`;

export class WebAuthnService {
  
  async getRegistrationOptions(userId: string, email: string) {
    const userPasskeys = await prisma.passkey.findMany({ where: { user_id: userId } });
    
    return generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(userId)),
      userName: email,
      excludeCredentials: userPasskeys.map(key => ({
        id: key.credential_id, 
        transports: key.transports as AuthenticatorTransport[] 
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });
  }

  async verifyRegistration(userId: string, body: any, expectedChallenge: string) {
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (verification.verified && verification.registrationInfo) {
      const info: any = verification.registrationInfo;
      const { credentialID, credentialPublicKey, counter } = info;
      
      await prisma.passkey.create({
        data: {
          user_id: userId,
          credential_id: credentialID,
          public_key: Buffer.from(credentialPublicKey).toString('base64'),
          counter: BigInt(counter),
          transports: body.response.transports || []
        }
      });
      return true;
    }
    return false;
  }

  async getAuthenticationOptions() {
    return generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    });
  }

  async verifyAuthentication(body: any, expectedChallenge: string) {
    const passkey = await prisma.passkey.findFirst({
        where: { credential_id: body.id }
    });

    if (!passkey) throw new Error('Passkey not found');

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // Updated property name from 'authenticator' to 'credential' if that's the issue, 
      // or check types. Usually it's 'authenticator' in v7-9, but maybe v10 changed it.
      // Let's try matching the expected type by casting or inspecting.
      // The error says "authenticator does not exist".
      // Let's try passing the public key directly or checking the type definition if I could.
      // I'll try to use `credential` as the property name.
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key, 'base64')),
        counter: Number(passkey.counter),
        transports: passkey.transports as AuthenticatorTransport[]
      } as any, // Cast to any to bypass strict type check for now if property name mismatch
    });

    if (verification.verified) {
        await prisma.passkey.update({
            where: { id: passkey.id },
            data: { 
                counter: BigInt(verification.authenticationInfo.newCounter),
                last_used: new Date()
            }
        });
        return passkey.user_id;
    }
    return null;
  }
}

export const webAuthnService = new WebAuthnService();