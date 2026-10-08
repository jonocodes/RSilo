import { describe, it, expect } from 'vitest';
import { hasScope, scopeFromPath, parseAuthHeader } from '../src/services/auth';

describe('hasScope', () => {
  it('exact match grants access', () => {
    expect(hasScope('documents:rw', 'documents:rw')).toBe(true);
  });

  it('rw satisfies r requirement', () => {
    expect(hasScope('documents:rw', 'documents:r')).toBe(true);
  });

  it('r does not satisfy rw requirement', () => {
    expect(hasScope('documents:r', 'documents:rw')).toBe(false);
  });

  it('wildcard * grants any scope', () => {
    expect(hasScope('*', 'pictures:rw')).toBe(true);
    expect(hasScope('*', 'anything:r')).toBe(true);
  });

  it('different module does not grant access', () => {
    expect(hasScope('pictures:rw', 'documents:rw')).toBe(false);
  });

  it('multiple scopes — matching one grants access', () => {
    expect(hasScope('pictures:rw documents:r', 'documents:r')).toBe(true);
  });

  it('required scope without colon returns false', () => {
    expect(hasScope('documents:rw', 'documents')).toBe(false);
  });

  it('empty scopes returns false', () => {
    expect(hasScope('', 'documents:rw')).toBe(false);
  });
});

describe('scopeFromPath', () => {
  it('extracts module from /storage/:user/:module/path', () => {
    expect(scopeFromPath('/storage/alice/documents/file.txt').module).toBe('documents');
  });

  it('extracts module from /:user/:module/path (no storage prefix)', () => {
    expect(scopeFromPath('/alice/pictures/photo.jpg').module).toBe('pictures');
  });

  it('returns fallback for very short path', () => {
    const { module } = scopeFromPath('/storage/alice');
    expect(typeof module).toBe('string');
  });
});

describe('parseAuthHeader', () => {
  it('extracts token from Bearer header', () => {
    expect(parseAuthHeader('Bearer mytoken123')).toBe('mytoken123');
  });

  it('trims whitespace around the token', () => {
    expect(parseAuthHeader('Bearer  mytoken123 ')).toBe('mytoken123');
  });

  it('returns null for an empty Bearer token', () => {
    expect(parseAuthHeader('Bearer   ')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseAuthHeader(null)).toBeNull();
  });

  it('returns null for Basic auth', () => {
    expect(parseAuthHeader('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for lowercase bearer', () => {
    expect(parseAuthHeader('bearer mytoken')).toBeNull();
  });
});
