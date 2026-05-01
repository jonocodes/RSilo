import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signSessionToken, verifySessionToken } from '../src/services/auth';

describe('hashPassword / verifyPassword', () => {
  it('returns pbkdf2 format string', async () => {
    const hash = await hashPassword('mysecret');
    expect(hash).toMatch(/^pbkdf2:100000:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('verifies correct password', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    expect(await verifyPassword('correcthorsebatterystaple', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    expect(await verifyPassword('wrongpassword', hash)).toBe(false);
  });

  it('produces unique salts for identical passwords', async () => {
    const h1 = await hashPassword('samepassword');
    const h2 = await hashPassword('samepassword');
    expect(h1).not.toBe(h2);
    // But both should verify correctly
    expect(await verifyPassword('samepassword', h1)).toBe(true);
    expect(await verifyPassword('samepassword', h2)).toBe(true);
  });

  it('rejects malformed hash', async () => {
    expect(await verifyPassword('password', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('password', 'bcrypt:$2b$10$invalid')).toBe(false);
  });
});

describe('signSessionToken / verifySessionToken', () => {
  const secret = 'test-secret-key';

  it('round-trips username', async () => {
    const token = await signSessionToken('alice', secret);
    const username = await verifySessionToken(token, secret);
    expect(username).toBe('alice');
  });

  it('returns null for wrong secret', async () => {
    const token = await signSessionToken('alice', secret);
    const username = await verifySessionToken(token, 'wrong-secret');
    expect(username).toBeNull();
  });

  it('returns null for tampered payload', async () => {
    const token = await signSessionToken('alice', secret);
    const [data, sig] = token.split('.');
    // Change the username in the payload
    const tampered = btoa(JSON.stringify({ username: 'mallory', exp: 9999999999 }));
    const result = await verifySessionToken(`${tampered}.${sig}`, secret);
    expect(result).toBeNull();
  });

  it('returns null for expired token', async () => {
    // Craft a token with exp in the past
    const exp = Math.floor(Date.now() / 1000) - 1;
    const data = btoa(JSON.stringify({ username: 'alice', exp }));
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const rawData = new TextEncoder().encode(JSON.stringify({ username: 'alice', exp }));
    const sig = await crypto.subtle.sign('HMAC', key, rawData);
    const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    const expiredToken = `${data}.${sigHex}`;
    expect(await verifySessionToken(expiredToken, secret)).toBeNull();
  });

  it('returns null for malformed token', async () => {
    expect(await verifySessionToken('notavalidtoken', secret)).toBeNull();
    expect(await verifySessionToken('', secret)).toBeNull();
  });
});
