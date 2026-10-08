import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
// Requests go to http://localhost in dev mode (vitest sets RSILO_DEV_MODE), so
// the dev identity signs them in as the Owner; see identity.test.ts for the
// production resolver. State changes carry the header a browser sends for a
// same-origin form post or fetch.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

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

describe('Files — browse', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
  });

  beforeEach(() => storage.clear());

  it('GET /account/browse shows empty state when no files', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Files — RSilo</title>');
    expect(html).toContain('No files yet');
  });

  it('GET /account/browse lists uploaded files', async () => {
    storage.set('users/alice/storage/documents/hello.txt', {
      body: new TextEncoder().encode('hello').buffer,
      contentType: 'text/plain',
      etag: '"abc"',
    });
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse', { method: 'GET' }, env);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET' }, env);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET' }, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onsubmit=');
    expect(html).toContain('quote\'&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.txt');
  });

  it('breadcrumb shows correct path segments', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse/documents/sub', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Home');
    expect(html).toContain('documents');
    expect(html).toContain('sub');
  });
});

describe('Files — download', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/download/documents/hello.txt', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('hello.txt');
    const text = await res.text();
    expect(text).toBe('hello world');
  });

  it('GET /account/download returns 404 for missing file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/download/documents/missing.txt', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });


  it('GET /account/download serves nested path file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/download/documents/sub/nested.md', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('nested.md');
    expect(await res.text()).toBe('# nested');
  });
});

describe('Files — view', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/view/documents/readme.md', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('# Hello World');
    expect(html).toContain('readme.md');
  });

  it('renders script terminators as inert text under a restrictive CSP', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/view/documents/malicious.txt', { method: 'GET' }, env);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/client.js', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(await res.text()).toContain("addEventListener('click'");
  });

  it('GET /account/view redirects binary file to download', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/view/documents/data.bin', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/account/download/');
  });

  it('GET /account/view returns 404 for missing file', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/view/documents/missing.txt', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});

describe('Files — delete', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
  });

  beforeEach(() => {
    storage.set('users/alice/storage/documents/todelete.txt', {
      body: new TextEncoder().encode('bye').buffer,
      contentType: 'text/plain',
      etag: '"xyz"',
    });
  });

  it('POST /account/delete removes file and redirects', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST', headers: SAME_ORIGIN }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/documents/todelete.txt')).toBe(false);
  });

  it('POST /account/delete redirects to parent folder', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST', headers: SAME_ORIGIN }, env);
    expect(res.headers.get('Location')).toContain('/account/browse');
  });
});

describe('Dashboard', () => {
  let app: ReturnType<typeof createServer>;
  const now = Math.floor(Date.now() / 1000);
  const mockTokens = [
    { id: 'tok-1', client_id: 'https://notes.example', scopes: 'documents:rw', user_id: 'alice', expires_at: now + 3600, created_at: now - 86400 * 3 },
    { id: 'tok-2', client_id: 'https://notes.example', scopes: 'pictures:r', user_id: 'alice', expires_at: now - 1, created_at: now },
    { id: 'tok-3', client_id: 'another-app', scopes: 'music:r', user_id: 'alice', expires_at: now + 3600, created_at: now },
  ];

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb(null, mockTokens) } as any);
  });

  it('GET /account shows the Storage address, usage and sign-out', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb({ username: 'alice', storage_quota_bytes: 10737418240, used_storage_bytes: 1048576 }, []) } as any;
    const res = await app.request('http://localhost/account', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice@localhost:8787');
    expect(html).toContain('data-copy-target="storage-address"');
    expect(html).toContain('1.0 MB of 10.0 GB used');
    expect(html).toContain('name="quota_gb"');
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).toContain('<h2>Public files</h2>');
    expect(html).toContain('No apps have access yet');
  });

  it('GET /account lists apps grouped by client, shown by origin host', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb(null, mockTokens) } as any;
    const res = await app.request('http://localhost/account', { method: 'GET' }, env);
    const html = await res.text();
    expect(html.split('action="/account/apps/revoke"')).toHaveLength(3);
    expect(html).toContain('<strong>notes.example</strong>');
    expect(html).toContain('documents:rw pictures:r');
    expect(html).toContain(new Date((now - 86400 * 3) * 1000).toISOString().slice(0, 10));
    expect(html).toContain('<strong>another-app</strong>');
  });

  it('GET /account/tokens redirects to the dashboard', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/tokens', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account');
  });

  it('serves the copy button behaviour from client.js', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/client.js', { method: 'GET' }, env);
    expect(await res.text()).toContain('navigator.clipboard.writeText');
  });
});

describe('Files — upload', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
  });

  beforeEach(() => storage.clear());

  it('POST /account/upload stores file and redirects', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const formData = new FormData();
    formData.append('files', new File(['hello upload'], 'test.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/documents/test.txt')).toBe(true);
  });

  it('POST /account/upload with no file redirects without storing', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const formData = new FormData();
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.size).toBe(0);
  });
});

describe('Account routing', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
  });

  for (const path of ['/admin', '/admin/', '/admin/users', '/admin/debug/env']) {
    it(`GET ${path} redirects to /account with 301`, async () => {
      const res = await app.request(`http://localhost${path}`, { method: 'GET' }, { STORAGE: mockStorage, DB: makeDb() } as any);
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('/account');
    });
  }

  it('GET /account/ redirects to /account (no trailing slash) with 301', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/', { method: 'GET' }, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/account');
  });
});

describe('Files — save (edit)', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const form = new FormData();
    form.append('content', 'updated content');
    const res = await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(204);
    const stored = storage.get('users/alice/storage/documents/note.txt');
    expect(new TextDecoder().decode(stored?.body as ArrayBuffer)).toBe('updated content');
  });

  it('POST /account/save preserves content type', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const form = new FormData();
    form.append('content', 'new');
    await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(storage.get('users/alice/storage/documents/note.txt')?.contentType).toBe('text/plain');
  });
});

describe('Files — root browse listing', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
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
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/browse', {
      method: 'GET',
      headers: SAME_ORIGIN,
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

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
  });

  beforeEach(() => storage.clear());

  it('POST /account/upload/a/b/c stores file at full nested path', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const form = new FormData();
    form.append('files', new File(['data'], 'file.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/photos/2024/summer', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.has('users/alice/storage/photos/2024/summer/file.txt')).toBe(true);
  });

  it('POST /account/upload redirects to correct nested browse path', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const form = new FormData();
    form.append('files', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/photos/2024', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.headers.get('Location')).toBe('/account/browse/photos/2024');
  });
});

describe('Files — view binary redirect URL', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: mockStorage, DB: makeDb() } as any);
    storage.set('users/alice/storage/photos/2024/img.png', {
      body: new Uint8Array([0x89, 0x50]).buffer,
      contentType: 'image/png',
      etag: '"png1"',
    });
  });

  it('view redirects binary to download using real path separators', async () => {
    const env = { STORAGE: mockStorage, DB: makeDb() } as any;
    const res = await app.request('http://localhost/account/view/photos/2024/img.png', {
      method: 'GET',
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toBe('/account/download/photos/2024/img.png');
    expect(location).not.toContain('%2F');
  });
});
