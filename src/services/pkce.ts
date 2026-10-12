// PKCE (RFC 7636), S256 only. The plain method is refused: it offers no
// protection when the authorization request itself can be observed.

export const PKCE_METHODS = ['S256'] as const;

// base64url(SHA-256(verifier)) without padding is always 43 characters.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 §4.1: 43-128 unreserved characters.
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export type PkceRequest =
  | { ok: true; challenge: { codeChallenge: string; method: 'S256' } | null }
  | { ok: false; description: string };

/** Validates the code_challenge pair of an authorization request; null when the app sent none. */
export function parsePkceRequest(codeChallenge: string, method: string): PkceRequest {
  if (!codeChallenge && !method) return { ok: true, challenge: null };
  if (!codeChallenge) {
    return { ok: false, description: 'code_challenge_method requires a code_challenge' };
  }
  // An absent method means plain (RFC 7636 §4.3).
  if (method !== 'S256') {
    return { ok: false, description: 'code_challenge_method must be S256' };
  }
  if (!CHALLENGE.test(codeChallenge)) {
    return { ok: false, description: 'code_challenge must be 43 base64url characters' };
  }
  return { ok: true, challenge: { codeChallenge, method } };
}

/** True when code_verifier hashes to the stored S256 code_challenge. */
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!VERIFIER.test(codeVerifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
  const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return encoded === codeChallenge;
}
