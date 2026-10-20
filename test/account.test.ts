import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createServer } from '../src/index';
import { createSqliteD1 } from '../src/services/db/sqlite';
import { MemoryStorage } from './helpers/memory-storage';
// Requests go to http://localhost in dev mode (vitest sets RSILO_DEV_MODE), so
// the dev identity signs them in as the Owner; see identity.test.ts for the
// production resolver. State changes carry the header a browser sends for a
// same-origin form post or fetch.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };

const storage = new MemoryStorage();

interface TokenRow {
  id: string;
  client_id: string;
  scopes: string;
  user_id: string;
  expires_at: number;
  /** Set for a token with a refresh token. */
  refresh_expires_at?: number;
  created_at: number;
}

function makeDb(
  user: { username: string; storage_quota_bytes?: number; used_storage_bytes?: number } | null = null,
  tokens: TokenRow[] = [],
) {
  const db = createSqliteD1();
  if (user) {
    db.sqlite.prepare('INSERT INTO users (id, username, storage_quota_bytes, used_storage_bytes) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), user.username, user.storage_quota_bytes ?? 0, user.used_storage_bytes ?? 0);
  }
  for (const token of tokens) {
    db.sqlite.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)').run(crypto.randomUUID(), token.user_id);
    db.sqlite.prepare('INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, created_at, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(token.client_id, token.client_id, '[]', token.created_at, token.user_id);
    db.sqlite.prepare(
      'INSERT INTO oauth_tokens (id, access_token_hash, refresh_token_hash, expires_at, refresh_expires_at, scopes, user_id, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      token.id, `hash-${token.id}`, token.refresh_expires_at ? `refresh-${token.id}` : null, token.expires_at,
      token.refresh_expires_at ?? null, token.scopes, token.user_id, token.client_id, token.created_at,
    );
  }
  return db;
}

describe('Files — browse', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => storage.objects.clear());

  it('GET /account/browse shows empty state when no files', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/browse', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Files — RSilo</title>');
    expect(html).toContain('No files yet');
  });

  it('GET /account/browse lists uploaded files', async () => {
    storage.seed('users/alice/storage/documents/hello.txt', 'hello');
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/browse', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('documents');
  });

  it('GET /account/browse/documents lists files in module', async () => {
    storage.seed('users/alice/storage/documents/notes.txt', 'notes');
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('notes.txt');
    expect(html).toContain('documents');
  });

  it('renders quote-bearing filenames without executable attributes', async () => {
    const filename = `quote'\"><img src=x onerror=alert(1)>.txt`;
    storage.seed(`users/alice/storage/documents/${filename}`, 'safe');
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/browse/documents', { method: 'GET' }, env);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onsubmit=');
    expect(html).toContain('quote\'&quot;&gt;&lt;img src=x onerror=alert(1)&gt;.txt');
  });

  it('breadcrumb shows correct path segments', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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
    app = createServer({ STORAGE: storage, DB: makeDb() });
    storage.seed('users/alice/storage/documents/hello.txt', 'hello world');
    storage.seed('users/alice/storage/documents/sub/nested.md', '# nested', 'text/markdown');
  });

  it('GET /account/download serves file with correct content', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/download/documents/hello.txt', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('hello.txt');
    const text = await res.text();
    expect(text).toBe('hello world');
  });

  it('GET /account/download returns 404 for missing file', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/download/documents/missing.txt', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });


  it('GET /account/download serves nested path file', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/download/documents/sub/nested.md', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('nested.md');
    expect(await res.text()).toBe('# nested');
  });
});

describe('Files — view', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
    storage.seed('users/alice/storage/documents/readme.md', '# Hello World');
    storage.seed('users/alice/storage/documents/data.bin', new Uint8Array([0x00, 0xff, 0xfe]), 'application/octet-stream');
    storage.seed('users/alice/storage/documents/malicious.txt', '</script><script>alert("stored-xss")</script>');
  });

  it('GET /account/view renders text file as HTML', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/view/documents/readme.md', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('# Hello World');
    expect(html).toContain('readme.md');
  });

  it('renders script terminators as inert text under a restrictive CSP', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/client.js', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    expect(await res.text()).toContain("addEventListener('click'");
  });

  it('GET /account/view redirects binary file to download', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/view/documents/data.bin', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/account/download/');
  });

  it('GET /account/view returns 404 for missing file', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/view/documents/missing.txt', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});

describe('Files — delete', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => {
    storage.seed('users/alice/storage/documents/todelete.txt', 'bye');
  });

  it('POST /account/delete removes file and redirects', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/delete/documents/todelete.txt', { method: 'POST', headers: SAME_ORIGIN }, env);
    expect(res.status).toBe(302);
    expect(storage.objects.has('users/alice/storage/documents/todelete.txt')).toBe(false);
  });

  it('POST /account/delete redirects to parent folder', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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
    // Access token expired, refresh token still valid: the app keeps access.
    { id: 'tok-4', client_id: 'https://sync.example', scopes: 'notes:rw', user_id: 'alice', expires_at: now - 1, refresh_expires_at: now + 86400, created_at: now },
    // Everything expired: not an app with access any more.
    { id: 'tok-5', client_id: 'https://gone.example', scopes: 'videos:rw', user_id: 'alice', expires_at: now - 1, refresh_expires_at: now - 1, created_at: now },
  ];

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb(null, mockTokens) });
  });

  it('GET /account shows the Storage address, usage and sign-out', async () => {
    const env = { STORAGE: storage, DB: makeDb({ username: 'alice', storage_quota_bytes: 10737418240, used_storage_bytes: 1048576 }, []) };
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
    const env = { STORAGE: storage, DB: makeDb(null, mockTokens) };
    const res = await app.request('http://localhost/account', { method: 'GET' }, env);
    const html = await res.text();
    expect(html.split('action="/account/apps/revoke"')).toHaveLength(4);
    expect(html).toContain('<strong>notes.example</strong>');
    expect(html).toContain(new Date((now - 86400 * 3) * 1000).toISOString().slice(0, 10));
    expect(html).toContain('<strong>another-app</strong>');
    expect(html).toContain('<strong>sync.example</strong>');
  });

  it('GET /account leaves out expired tokens and apps whose grants have all expired', async () => {
    const env = { STORAGE: storage, DB: makeDb(null, mockTokens) };
    const html = await (await app.request('http://localhost/account', { method: 'GET' }, env)).text();
    expect(html).toContain('>documents:rw</span>');
    expect(html).not.toContain('pictures:r');
    expect(html).not.toContain('gone.example');
  });

  it('GET /account without a database is a 503, not an empty dashboard', async () => {
    const res = await app.request('http://localhost/account', { method: 'GET' }, { STORAGE: storage });
    expect(res.status).toBe(503);
  });

  it('GET /account/tokens redirects to the dashboard', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/tokens', { method: 'GET' }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account');
  });

  it('serves the copy button behaviour from client.js', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/client.js', { method: 'GET' }, env);
    expect(await res.text()).toContain('navigator.clipboard.writeText');
  });
});

describe('Files — upload', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => storage.objects.clear());

  it('POST /account/upload stores file and redirects', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const formData = new FormData();
    formData.append('files', new File(['hello upload'], 'test.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.objects.has('users/alice/storage/documents/test.txt')).toBe(true);
  });

  it('POST /account/upload with no file redirects without storing', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const formData = new FormData();
    const res = await app.request('http://localhost/account/upload/documents', {
      method: 'POST',
      body: formData,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.objects.size).toBe(0);
  });
});

describe('Account routing', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  for (const path of ['/admin', '/admin/', '/admin/users', '/admin/debug/env']) {
    it(`GET ${path} redirects to /account with 301`, async () => {
      const res = await app.request(`http://localhost${path}`, { method: 'GET' }, { STORAGE: storage, DB: makeDb() });
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('/account');
    });
  }

  it('GET /account/ redirects to /account (no trailing slash) with 301', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/', { method: 'GET' }, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/account');
  });
});

describe('Files — save (edit)', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => {
    storage.objects.clear();
    storage.seed('users/alice/storage/documents/note.txt', 'original content', 'text/markdown');
  });

  it('POST /account/save updates file content', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const form = new FormData();
    form.append('content', 'updated content');
    const res = await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(204);
    expect(storage.text('users/alice/storage/documents/note.txt')).toBe('updated content');
  });

  it('POST /account/save preserves content type', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const form = new FormData();
    form.append('content', 'new');
    await app.request('http://localhost/account/save/documents/note.txt', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(storage.objects.get('users/alice/storage/documents/note.txt')?.contentType).toBe('text/markdown');
  });
});

describe('Files — root browse listing', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => {
    storage.objects.clear();
    storage.seed('users/alice/storage/photos/img.jpg', new Uint8Array([0xff, 0xd8]), 'image/jpeg');
    storage.seed('users/alice/storage/documents/note.txt', 'hi');
  });

  it('root browse shows full folder names without truncation', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => storage.objects.clear());

  it('POST /account/upload/a/b/c stores file at full nested path', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const form = new FormData();
    form.append('files', new File(['data'], 'file.txt', { type: 'text/plain' }));
    const res = await app.request('http://localhost/account/upload/photos/2024/summer', {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, env);
    expect(res.status).toBe(302);
    expect(storage.objects.has('users/alice/storage/photos/2024/summer/file.txt')).toBe(true);
  });

  it('POST /account/upload redirects to correct nested browse path', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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
    app = createServer({ STORAGE: storage, DB: makeDb() });
    storage.seed('users/alice/storage/photos/2024/img.png', new Uint8Array([0x89, 0x50]), 'image/png');
  });

  it('view redirects binary to download using real path separators', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
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

describe('Files — nested paths keep real separators', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => {
    storage.objects.clear();
    storage.seed('users/alice/storage/documents/a/b/note.txt', 'hi');
  });

  it('browse and view breadcrumbs link each folder by its real path', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    for (const url of ['http://localhost/account/browse/documents/a/b', 'http://localhost/account/view/documents/a/b/note.txt']) {
      const html = await (await app.request(url, { method: 'GET' }, env)).text();
      expect(html).toContain('href="/account/browse/documents/a"');
      expect(html).toContain('href="/account/browse/documents/a/b"');
      expect(html).not.toContain('%2F');
    }
  });

  it('delete redirects to the real parent path', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const res = await app.request('http://localhost/account/delete/documents/a/b/note.txt', { method: 'POST', headers: SAME_ORIGIN }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account/browse/documents/a/b');
  });
});

describe('Files — path validation', () => {
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = createServer({ STORAGE: storage, DB: makeDb() });
  });

  beforeEach(() => {
    storage.objects.clear();
    storage.seed('users/alice/storage/documents/.hidden', 'legacy');
  });

  const upload = (folder: string, filename: string) => {
    const form = new FormData();
    form.append('files', new File(['x'], filename, { type: 'text/plain' }));
    return app.request(`http://localhost/account/upload/${folder}`, {
      method: 'POST',
      body: form,
      headers: SAME_ORIGIN,
    }, { STORAGE: storage, DB: makeDb() });
  };

  it('rejects upload file names the storage API would refuse, writing nothing', async () => {
    for (const [folder, filename] of [
      ['documents', '../../escape.txt'],
      ['documents', 'sub/file.txt'],
      ['documents', '..'],
    ]) {
      const res = await upload(folder, filename);
      expect(res.status).toBe(400);
    }
    expect([...storage.objects.keys()]).toEqual(['users/alice/storage/documents/.hidden']);
  });

  it('accepts dot-leading names, which the storage API allows (protocol §4)', async () => {
    expect((await upload('documents', '.env')).status).toBe(302);
    expect((await upload('.config', 'file.txt')).status).toBe(302);
    expect(storage.objects.has('users/alice/storage/documents/.env')).toBe(true);
    expect(storage.objects.has('users/alice/storage/.config/file.txt')).toBe(true);
  });

  it('rejects saving or deleting a path the storage API would refuse', async () => {
    const env = { STORAGE: storage, DB: makeDb() };
    const form = new FormData();
    form.append('content', 'overwritten');
    // An encoded "/" or a NUL can't be part of a name (protocol §4)
    for (const bad of ['documents/a%2Fb', 'documents/a%00b']) {
      const save = await app.request(`http://localhost/account/save/${bad}`, { method: 'POST', body: form, headers: SAME_ORIGIN }, env);
      expect(save.status).toBe(400);
      const del = await app.request(`http://localhost/account/delete/${bad}`, { method: 'POST', headers: SAME_ORIGIN }, env);
      expect(del.status).toBe(400);
    }

    expect(storage.text('users/alice/storage/documents/.hidden')).toBe('legacy');
  });
});
