import { describe, it, expect } from 'vitest';
import { authorize, grants, moduleOf, parseAuthHeader, parseScope, parseScopes } from '../src/services/auth';
import type { TokenPayload } from '../src/services/auth';

describe('parseScope / parseScopes', () => {
  it('accepts <module>:r and <module>:rw, and * for the whole root', () => {
    expect(parseScope('documents:r')).toEqual({ module: 'documents', access: 'r' });
    expect(parseScope('my_notes-2:rw')).toEqual({ module: 'my_notes-2', access: 'rw' });
    // Any valid item name, as remoteStorage.js allows; the level is after the last colon.
    expect(parseScope('myFavoriteDrinks:rw')).toEqual({ module: 'myFavoriteDrinks', access: 'rw' });
    expect(parseScope('my.app:r')).toEqual({ module: 'my.app', access: 'r' });
    expect(parseScope('a:b:rw')).toEqual({ module: 'a:b', access: 'rw' });
    expect(parseScope('*:rw')).toEqual({ module: '*', access: 'rw' });
    expect(parseScopes('documents:rw pictures:r')).toEqual([
      { module: 'documents', access: 'rw' },
      { module: 'pictures', access: 'r' },
    ]);
  });

  it('rejects anything else, including bare * and the reserved public module', () => {
    for (const item of ['*', 'documents', 'documents:', 'documents:read', 'documents:rwx', 'documents:w', 'a/b:rw', ':rw', '.:rw', '..:rw', 'public:rw']) {
      expect(parseScope(item), item).toBeNull();
    }
  });

  it('rejects a scope string that is empty or has any malformed item', () => {
    expect(parseScopes('')).toBeNull();
    expect(parseScopes('   ')).toBeNull();
    expect(parseScopes('documents:rw *')).toBeNull();
  });
});

describe('grants', () => {
  it('matches the module exactly; rw includes r but r does not include rw', () => {
    expect(grants('documents:rw', 'documents', 'rw')).toBe(true);
    expect(grants('documents:rw', 'documents', 'r')).toBe(true);
    expect(grants('documents:r', 'documents', 'rw')).toBe(false);
    expect(grants('pictures:rw', 'documents', 'r')).toBe(false);
    expect(grants('pictures:rw documents:r', 'documents', 'r')).toBe(true);
  });

  it('*:<level> covers every module and the root', () => {
    expect(grants('*:r', 'pictures', 'r')).toBe(true);
    expect(grants('*:r', '*', 'rw')).toBe(false);
    expect(grants('*:rw', '*', 'rw')).toBe(true);
  });

  it('grants nothing for malformed scopes, a bare * or a prefix of the level', () => {
    expect(grants('*', 'documents', 'r')).toBe(false);
    expect(grants('documents:rwhatever', 'documents', 'rw')).toBe(false);
    expect(grants('documents:read', 'documents', 'r')).toBe(false);
    expect(grants('', 'documents', 'r')).toBe(false);
  });
});

describe('moduleOf', () => {
  it('is the first segment of a path inside a module, public or not', () => {
    expect(moduleOf('documents/file.txt')).toBe('documents');
    expect(moduleOf('documents/')).toBe('documents');
    expect(moduleOf('documents/a/b/')).toBe('documents');
    expect(moduleOf('public/documents/file.txt')).toBe('documents');
    expect(moduleOf('public/documents/')).toBe('documents');
  });

  it('is * for the root folder, root-level documents, public/ and documents directly in it', () => {
    for (const path of ['', 'documents', 'public', 'public/', 'public/file.txt']) {
      expect(moduleOf(path), path).toBe('*');
    }
  });
});

describe('authorize', () => {
  const token = (scopes: string): TokenPayload => ({ sub: 'alice', scopes, iat: 0, exp: 0 });

  it('lets anyone read a public document, but not list or write public/', () => {
    expect(authorize(null, 'alice', 'public/documents/a.txt', 'r')).toBeNull();
    expect(authorize(null, 'alice', 'public/documents/', 'r')).toEqual({ status: 401 });
    expect(authorize(null, 'alice', 'public/documents/a.txt', 'rw')).toEqual({ status: 401 });
  });

  it('needs a token for everything else', () => {
    expect(authorize(null, 'alice', 'documents/a.txt', 'r')).toEqual({ status: 401 });
  });

  it('refuses a token for another account', () => {
    expect(authorize(token('*:rw'), 'bob', 'documents/a.txt', 'r')).toEqual({ status: 403 });
  });

  it('allows what the scopes cover and names the scope otherwise', () => {
    expect(authorize(token('documents:rw'), 'alice', 'documents/a.txt', 'rw')).toBeNull();
    expect(authorize(token('documents:rw'), 'alice', 'public/documents/a.txt', 'rw')).toBeNull();
    expect(authorize(token('documents:r'), 'alice', 'documents/a.txt', 'rw')).toEqual({ status: 403, requiredScope: 'documents:rw' });
  });

  it('keeps root-level documents and public/ itself to *', () => {
    expect(authorize(token('foo:rw'), 'alice', 'foo', 'rw')).toEqual({ status: 403, requiredScope: '*:rw' });
    expect(authorize(token('foo:rw'), 'alice', 'public/foo', 'rw')).toEqual({ status: 403, requiredScope: '*:rw' });
    expect(authorize(token('documents:r'), 'alice', 'public/', 'r')).toEqual({ status: 403, requiredScope: '*:r' });
    expect(authorize(token('*:rw'), 'alice', 'foo', 'rw')).toBeNull();
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
