// Google's and Apple's signed tokens, checked against their published keys.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './errors';
import type { OAuthProfile } from './directory/core';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function googleProfile(idToken: string, audience: string | undefined): Promise<OAuthProfile> {
  if (!audience) throw new ApiError(503, 'google_disabled', 'Google sign-in is not configured on this server');
  let p;
  try {
    ({ payload: p } = await jwtVerify(idToken, googleKeys, { audience, issuer: ['https://accounts.google.com', 'accounts.google.com'] }));
  } catch {
    throw new ApiError(401, 'google_token_invalid', 'that Google sign-in could not be verified');
  }
  if (typeof p.sub !== 'string' || typeof p.email !== 'string') throw new ApiError(401, 'google_token_invalid', 'Google token carried no account');
  if (p.email_verified !== true) throw new ApiError(403, 'email_unverified', 'your Google email address is not verified');
  return { provider: 'google', sub: p.sub, email: p.email.toLowerCase(), hostedDomain: typeof p.hd === 'string' ? p.hd.toLowerCase() : null, name: p.name as string | undefined };
}

export async function appleProfile(identityToken: string, name: string | undefined, audience: string | undefined): Promise<OAuthProfile> {
  if (!audience) throw new ApiError(503, 'apple_disabled', 'Sign in with Apple is not configured on this server');
  let p;
  try {
    ({ payload: p } = await jwtVerify(identityToken, appleKeys, { audience, issuer: 'https://appleid.apple.com' }));
  } catch {
    throw new ApiError(401, 'apple_token_invalid', 'that Apple sign-in could not be verified');
  }
  if (typeof p.sub !== 'string' || typeof p.email !== 'string') throw new ApiError(401, 'apple_token_invalid', 'Apple token carried no account');
  if (p.email_verified !== true && p.email_verified !== 'true') throw new ApiError(403, 'email_unverified', 'your Apple email address is not verified');
  return { provider: 'apple', sub: p.sub, email: p.email.toLowerCase(), hostedDomain: null, name };
}
