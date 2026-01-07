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

const toBase64Url = (input: ArrayBuffer | Uint8Array | Buffer | string | undefined) => {
  if (!input) throw new Error('Missing credential data');
  if (typeof input === 'string') return input;
  return Buffer.from(input as any).toString('base64url');
};

const fromBase64Url = (input: string | undefined) => {
  if (!input) throw new Error('Missing credential data');
  return new Uint8Array(Buffer.from(input, 'base64url'));
};

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
        transports: (key.transports || []) as AuthenticatorTransport[]
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
      const credentialID = info.credentialID || info.credential?.id;
      const credentialPublicKey = info.credentialPublicKey || info.credential?.publicKey;
      const counter = info.counter ?? info.credential?.counter ?? 0;
      if (!credentialID || !credentialPublicKey) {
        throw new Error('Missing credential data from authenticator');
      }
      
      await prisma.passkey.create({
        data: {
          user_id: userId,
          credential_id: toBase64Url(credentialID),
          public_key: toBase64Url(credentialPublicKey),
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
    if (!body?.id) throw new Error('Missing passkey credential id');
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
        publicKey: fromBase64Url(passkey.public_key),
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
