import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { hashPassword, signSessionToken } from '../src/services/auth';

const SESSION_SECRET = 'test-session-secret';
const SESSION_EXPIRY = 28800;

const storage = new Map<string, { body: ArrayBufferLike; contentType: string; etag: string }>();

const mockStorage = {
  async get(key: string) {
    const item = storage.get(key);
    if (!item) return null;
    return { body: item.body, metadata: { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag } };
  },
  async put(key: string, body: ArrayBuffer, contentType: string) {
    const etag = `"etag-${Math.random().toString(36).slice(2)}"`;
    storage.set(key, { body, contentType, etag });
    return etag;
  },
  async delete(key: string) { storage.delete(key); },
  async head(key: string) {
    const item = storage.get(key);
    if (!item) return null;
    return { contentType: item.contentType, contentLength: item.body.byteLength, etag: item.etag };
  },
  async list(prefix: string) {
    const objects = Array.from(storage.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k, size: v.body.byteLength, etag: v.etag }));
    return { objects };
  },
} as any;

function makeDb(userRow: any = null, tokens: any[] = []) {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: any[]) => ({
        first: async () => sql.includes('users') ? userRow : null,
        run: async () => ({}),
        all: async () => ({ results: tokens }),
      }),
      first: async () => userRow,
      run: async () => ({}),
      all: async () => ({ results: tokens }),
    }),
  } as any;
}

async function makeSessionCookie(username: string): Promise<string> {
  const token = await signSessionToken(username, SESSION_SECRET, SESSION_EXPIRY);
  return `rsilo_session=${token}`;
}

describe('Files — login', () => {
  let app: ReturnType<typeof createServer>;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword('correctpass');
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
  });

  it('GET /account shows login page when not authenticated', async () => {
    const res = await app.request('http://localhost/account', { method: 'GET' }, { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in');
    expect(html).toContain('type="password"');
  });

  it('GET /account redirects to browse when already authenticated', async () => {
    const cookie = await makeSessionCookie('alice');
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/browse');
  });

  it('POST /account/login redirects to browse on correct credentials', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET } as any;
    const body = new URLSearchParams({ username: 'alice', password: 'correctpass' });
    const res = await app.request('http://localhost/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/browse');
    expect(res.headers.get('Set-Cookie')).toContain('rsilo_session=');
  });

  it('rejects a forged fallback-secret cookie when SESSION_SECRET is missing', async () => {
    const token = await signSessionToken('alice', 'dev-session-secret-change-in-production', SESSION_EXPIRY);
    const env = { STORAGE: mockStorage, DB: makeDb(), RSILO_DEV_MODE: 'false' } as any;
    const res = await app.request('http://localhost/account/browse', {
      method: 'GET',
      headers: { Cookie: `rsilo_session=${token}` },
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });

  it('returns 503 for a valid login when SESSION_SECRET is missing', async () => {
    const env = {
      STORAGE: mockStorage,
      DB: makeDb({ username: 'alice', password_hash: passwordHash }),
      RSILO_DEV_MODE: 'false',
    } as any;
    const body = new URLSearchParams({ username: 'alice', password: 'correctpass' });
    const res = await app.request('http://localhost/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('POST /account/login redirects with error on wrong password', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET } as any;
    const body = new URLSearchParams({ username: 'alice', password: 'wrongpass' });
    const res = await app.request('http://localhost/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=1');
  });

  it('POST /account/login redirects with error for unknown user', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(null), SESSION_SECRET } as any;
    const body = new URLSearchParams({ username: 'nobody', password: 'pass' });
    const res = await app.request('http://localhost/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('error=1');
  });

  it('temporarily locks out repeated login attempts', async () => {
    let attempts = 0;
    const env = {
      STORAGE: mockStorage,
      DB: makeDb(null),
      SESSION_SECRET,
      RSILO_DEV_MODE: 'false',
      LOGIN_LIMITER: { limit: async () => ({ success: ++attempts <= 5 }) },
    } as any;
    const request = () => app.request('http://localhost/account/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: new URLSearchParams({ username: 'alice', password: 'wrong' }).toString(),
    }, env);

    for (let attempt = 0; attempt < 5; attempt++) expect((await request()).status).toBe(302);
    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('POST /account/logout clears session cookie', async () => {
    const cookie = await makeSessionCookie('alice');
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('Files — auth redirect', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(() => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
  });

  for (const path of ['/account/browse', '/account/tokens']) {
    it(`GET ${path} redirects to login when unauthenticated`, async () => {
      const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
      const res = await app.request(`http://localhost${path}`, { method: 'GET' }, env);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/account/');
    });
  }
});

describe('Files — browse', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => storage.clear());

  it('GET /account/browse shows empty state when no files', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RSilo Files');
    expect(html).toContain('No files yet');
  });

  it('GET /account/browse lists uploaded files', async () => {
    storage.set('users/alice/storage/documents/hello.txt', {
      body: new TextEncoder().encode('hello').buffer,
      contentType: 'text/plain',
      etag: '"abc"',
    });
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('documents');
  });

  it('GET /account/browse/documents lists files in module', async () => {
    storage.set('users/alice/storage/documents/notes.txt', {
      body: new TextEncoder().encode('notes').buffer,
      contentType: 'text/plain',
      etag: '"def"',
    });
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('notes.txt');
    expect(html).toContain('documents');
  });

  it('renders quote-bearing filenames without executable attributes', async () => {
    const filename = `quote'\"><img src=x onerror=alert(1)>.txt`;
    storage.set(`users/alice/storage/documents/${filename}`, {
      body: new TextEncoder().encode('safe').buffer,
      contentType: 'text/plain',
      etag: '"quoted"',
    });
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET', headers: { Cookie: cookie } }, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onsubmit=');
    expect(html).toContain('quote\'&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.txt');
  });

  it('breadcrumb shows correct path segments', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse/documents/sub', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Home');
    expect(html).toContain('documents');
    expect(html).toContain('sub');
  });
});

describe('Files — download', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
    storage.set('users/alice/storage/documents/hello.txt', {
      body: new TextEncoder().encode('hello world').buffer,
      contentType: 'text/plain',
      etag: '"abc123"',
    });
    storage.set('users/alice/storage/documents/sub/nested.md', {
      body: new TextEncoder().encode('# nested').buffer,
      contentType: 'text/markdown',
      etag: '"def456"',
    });
  });

  it('GET /account/download serves file with correct content', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/download/documents/hello.txt', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('hello.txt');
    const text = await res.text();
    expect(text).toBe('hello world');
  });

  it('GET /account/download returns 404 for missing file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/download/documents/missing.txt', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(404);
  });

  it('GET /account/download redirects to login when unauthenticated', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/download/documents/hello.txt', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });

  it('GET /account/download serves nested path file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/download/documents/sub/nested.md', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('nested.md');
    expect(await res.text()).toBe('# nested');
  });
});

describe('Files — view', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
    storage.set('users/alice/storage/documents/readme.md', {
      body: new TextEncoder().encode('# Hello World').buffer,
      contentType: 'text/plain',
      etag: '"etag-view"',
    });
    storage.set('users/alice/storage/documents/data.bin', {
      body: new Uint8Array([0x00, 0xff, 0xfe]).buffer,
      contentType: 'application/octet-stream',
      etag: '"etag-bin"',
    });
    storage.set('users/alice/storage/documents/malicious.txt', {
      body: new TextEncoder().encode('</script><script>alert("stored-xss")</script>').buffer,
      contentType: 'text/plain',
      etag: '"etag-malicious"',
    });
  });

  it('GET /account/view renders text file as HTML', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/documents/readme.md', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('# Hello World');
    expect(html).toContain('readme.md');
  });

  it('renders script terminators as inert text under a restrictive CSP', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/documents/malicious.txt', { method: 'GET', headers: { Cookie: cookie } }, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'; script-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(&quot;stored-xss&quot;)&lt;/script&gt;');
    expect(html).not.toContain('onclick=');
    expect(html).toContain('<script src="/account/client.js" defer></script>');
  });

  it('serves account behavior as same-origin JavaScript', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/client.js', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(await res.text()).toContain("addEventListener('click'");
  });

  it('GET /account/view redirects binary file to download', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/documents/data.bin', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/account/download/');
  });

  it('GET /account/view returns 404 for missing file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/documents/missing.txt', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(404);
  });

  it('GET /account/view redirects to login when unauthenticated', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/documents/readme.md', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });
});

describe('Files — delete', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => {
    storage.set('users/alice/storage/documents/todelete.txt', {
      body: new TextEncoder().encode('bye').buffer,
      contentType: 'text/plain',
      etag: '"xyz"',
    });
  });

  it('POST /account/delete removes file and redirects', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/documents/todelete.txt')).toBe(false);
  });

  it('POST /account/delete redirects to parent folder', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST', headers: { Cookie: cookie } }, env);
    expect(res.headers.get('Location')).toContain('/account/browse');
  });

  it('POST /account/delete redirects to login when unauthenticated', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });
});

describe('Files — tokens', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  const mockTokens = [
    { id: 'tok-1', client_id: 'my-app', scopes: 'documents:rw', user_id: 'alice', expires_at: Math.floor(Date.now() / 1000) + 3600, created_at: Math.floor(Date.now() / 1000) },
    { id: 'tok-2', client_id: 'another-app', scopes: 'pictures:r', user_id: 'alice', expires_at: Math.floor(Date.now() / 1000) - 1, created_at: Math.floor(Date.now() / 1000) },
  ];

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(null, mockTokens), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  it('GET /account/tokens lists active tokens', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(null, mockTokens), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/tokens', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('my-app');
    expect(html).toContain('documents:rw');
    expect(html).toContain('Expired');
  });

  it('GET /account/tokens shows empty state when no tokens', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(null, []), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/tokens', { method: 'GET', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No active tokens');
  });

  it('POST /account/tokens/:id/revoke redirects to tokens page', async () => {
    const revokeDb = {
      prepare: (_sql: string) => ({
        bind: (..._args: any[]) => ({ run: async () => ({}) }),
      }),
    } as any;
    const env = { STORAGE: mockStorage, DB: revokeDb, SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/tokens/tok-1/revoke', { method: 'POST', headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/tokens');
  });
});

describe('Files — upload', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => storage.clear());

  it('POST /account/upload stores file and redirects', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const formData = new FormData();
    formData.append('files', new File(['hello upload'], 'test.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/documents/test.txt')).toBe(true);
  });

  it('POST /account/upload with no file redirects without storing', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const formData = new FormData();
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(302);
    expect(storage.size).toBe(0);
  });

  it('POST /account/upload redirects to login when unauthenticated', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const formData = new FormData();
    formData.append('files', new File(['data'], 'x.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });
});

describe('Files — session cookie flags', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
  });

  it('POST /account/login sets HttpOnly SameSite cookie', async () => {
    const passwordHash = await (await import('../src/services/auth')).hashPassword('correctpass');
    const env = { STORAGE: mockStorage, DB: makeDb({ username: 'alice', password_hash: passwordHash }), SESSION_SECRET } as any;
    const body = new URLSearchParams({ username: 'alice', password: 'correctpass' });
    const res = await app.request('http://localhost/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('GET /account/ redirects to /account (no trailing slash) with 301', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/', { method: 'GET' }, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/account');
  });
});

describe('Files — save (edit)', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => {
    storage.clear();
    storage.set('users/alice/storage/documents/note.txt', {
      body: new TextEncoder().encode('original content').buffer,
      contentType: 'text/plain',
      etag: '"orig"',
    });
  });

  it('POST /account/save updates file content', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const form = new FormData();
    form.append('content', 'updated content');
    const res = await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(204);
    const stored = storage.get('users/alice/storage/documents/note.txt');
    expect(new TextDecoder().decode(stored?.body as ArrayBuffer)).toBe('updated content');
  });

  it('POST /account/save preserves content type', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const form = new FormData();
    form.append('content', 'new');
    await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    }, env);
    expect(storage.get('users/alice/storage/documents/note.txt')?.contentType).toBe('text/plain');
  });

  it('POST /account/save redirects to login when unauthenticated', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const form = new FormData();
    form.append('content', 'x');
    const res = await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/');
  });
});

describe('Files — root browse listing', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => {
    storage.clear();
    storage.set('users/alice/storage/photos/img.jpg', {
      body: new Uint8Array([0xff, 0xd8]).buffer,
      contentType: 'image/jpeg',
      etag: '"ph1"',
    });
    storage.set('users/alice/storage/documents/note.txt', {
      body: new TextEncoder().encode('hi').buffer,
      contentType: 'text/plain',
      etag: '"doc1"',
    });
  });

  it('root browse shows full folder names without truncation', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/browse', {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/account/browse/photos"');
    expect(html).toContain('href="/account/browse/documents"');
    expect(html).not.toContain('href="/account/browse/hotos"');
    expect(html).not.toContain('href="/account/browse/ocuments"');
  });
});

describe('Files — nested path upload', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
  });

  beforeEach(() => storage.clear());

  it('POST /account/upload/a/b/c stores file at full nested path', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const form = new FormData();
    form.append('files', new File(['data'], 'file.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/photos/2024/summer', {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/photos/2024/summer/file.txt')).toBe(true);
  });

  it('POST /account/upload redirects to correct nested browse path', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const form = new FormData();
    form.append('files', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/photos/2024', {
      method: 'POST',
      body: form,
      headers: { Cookie: cookie },
    }, env);
    expect(res.headers.get('Location')).toBe('/account/browse/photos/2024');
  });
});

describe('Files — view binary redirect URL', () => {
  let app: ReturnType<typeof createServer>;
  let cookie: string;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any);
    cookie = await makeSessionCookie('alice');
    storage.set('users/alice/storage/photos/2024/img.png', {
      body: new Uint8Array([0x89, 0x50]).buffer,
      contentType: 'image/png',
      etag: '"png1"',
    });
  });

  it('view redirects binary to download using real path separators', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(), SESSION_SECRET } as any;
    const res = await app.request('http://localhost/account/view/photos/2024/img.png', {
      method: 'GET',
      headers: { Cookie: cookie },
    }, env);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toBe('/account/download/photos/2024/img.png');
    expect(location).not.toContain('%2F');
  });
});
