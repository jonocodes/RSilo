import { describe, it, expect } from 'vitest';
import { createServer } from '../src/index';
import { seedToken } from './helpers/tokens';

// An Instance serves one Account and advertises every URL from one configured
// origin (PUBLIC_BASE_URL), never from the request's Host or forwarding headers.

const BASE = 'https://rs.example:8443';

function createEnv(extra: Record<string, string> = {}) {
  return {
    STORAGE: {
      async get() { return null; },
      async put() { return '"etag"'; },
      async delete() {},
      async head() { return null; },
      async list() { return { objects: [] }; },
    } as any,
    DB: {} as any,
    ACCOUNT_USERNAME: 'alice',
    PUBLIC_BASE_URL: BASE,
    ...extra,
  };
}

const app = createServer({});

function q(resource: string): string {
  return `resource=${encodeURIComponent(resource)}`;
}

function remoteStorageLink(json: any) {
  return json.links.find((l: any) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
}

const ACCEPTED = [
  'acct:alice@rs.example:8443',
  'acct:ALICE@RS.Example:8443',
  'ACCT:Alice@rs.example:8443',
  'https://rs.example:8443',
  'https://rs.example:8443/',
  'http://rs.example:8443',
  'http://RS.EXAMPLE:8443/',
];

const REJECTED = [
  'acct:bob@rs.example:8443',
  'acct:alice@rs.example',
  'acct:alice@other.example:8443',
  'acct:alice@rs.example:8443/storage',
  'acct:alice@evil@rs.example:8443',
  'acct:@rs.example:8443',
  'https://other.example:8443',
  'https://rs.example',
  'https://rs.example:8443/storage/alice',
  'https://rs.example:8443/?x=1',
  'https://alice@rs.example:8443',
  'ftp://rs.example:8443',
  'mailto:alice@rs.example:8443',
  'alice@rs.example:8443',
  'not-acct-format',
];

describe('WebFinger accepts only the Account', () => {
  for (const resource of ACCEPTED) {
    it(`/.well-known/webfinger resolves ${resource} to the Account`, async () => {
      const res = await app.request(`http://localhost/.well-known/webfinger?${q(resource)}`, {}, createEnv());

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.subject).toBe(resource);
      const link = remoteStorageLink(json);
      expect(link.href).toBe(`${BASE}/storage/alice`);
      expect(link.properties['http://tools.ietf.org/html/rfc6749#section-4.2']).toBe(`${BASE}/oauth/alice/authorize`);
    });

    it(`/webfinger/jrd resolves ${resource} to the Account`, async () => {
      const res = await app.request(`http://localhost/webfinger/jrd?${q(resource)}`, {}, createEnv());

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.links[0].template).toBe(`${BASE}/storage/alice/{category}`);
      expect(json.links[0].auth).toBe(`${BASE}/oauth/alice/authorize`);
    });

    it(`/webfinger/xrd resolves ${resource} to the Account`, async () => {
      const res = await app.request(`http://localhost/webfinger/xrd?${q(resource)}`, {}, createEnv());

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(`href="${BASE}/storage/alice"`);
      expect(text).toContain(`href="${BASE}/oauth/alice/authorize"`);
    });
  }

  for (const resource of REJECTED) {
    for (const route of ['/.well-known/webfinger', '/webfinger/jrd', '/webfinger/xrd']) {
      it(`${route} returns 404 for ${resource}`, async () => {
        const res = await app.request(`http://localhost${route}?${q(resource)}`, {}, createEnv());
        expect(res.status).toBe(404);
      });
    }
  }

  it('/oauth/:user returns 404 for a username other than the Account', async () => {
    const res = await app.request('http://localhost/oauth/bob', {}, createEnv());
    expect(res.status).toBe(404);
  });

  it('/oauth/:user resolves the Account', async () => {
    const res = await app.request('http://localhost/oauth/alice', {}, createEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.owner).toBe('alice');
  });

  it('compares the host including a non-default port', async () => {
    const env = createEnv({ PUBLIC_BASE_URL: 'https://rs.example' });

    const plain = await app.request(`http://localhost/.well-known/webfinger?${q('acct:alice@rs.example')}`, {}, env);
    const defaultPort = await app.request(`http://localhost/.well-known/webfinger?${q('https://rs.example:443/')}`, {}, env);
    const otherPort = await app.request(`http://localhost/.well-known/webfinger?${q('acct:alice@rs.example:8443')}`, {}, env);

    expect(plain.status).toBe(200);
    expect(defaultPort.status).toBe(200);
    expect(otherPort.status).toBe(404);
  });
});

describe('Advertised URLs use PUBLIC_BASE_URL', () => {
  const spoofed = { Host: 'evil.example', 'X-Forwarded-Proto': 'http' };

  it('WebFinger ignores Host and X-Forwarded-Proto', async () => {
    const res = await app.request(`http://evil.example/.well-known/webfinger?${q('acct:alice@rs.example:8443')}`, { headers: spoofed }, createEnv());

    const json = await res.json() as any;
    expect(JSON.stringify(json)).not.toContain('evil.example');
    expect(remoteStorageLink(json).href).toBe(`${BASE}/storage/alice`);
    const simple = json.links.find((l: any) => l.rel === 'remoteStorage');
    expect(simple.auth).toBe(`${BASE}/oauth/alice/authorize`);
    expect(simple.template).toBe(`${BASE}/storage/alice/{category}`);
  });

  it('the lrdd template without a resource uses PUBLIC_BASE_URL', async () => {
    const res = await app.request('http://evil.example/.well-known/webfinger', { headers: spoofed }, createEnv());
    const json = await res.json() as any;
    expect(json.links[0].template).toBe(`${BASE}/webfinger/jrd?resource={uri}`);
  });

  it('/webfinger/jrd ignores Host', async () => {
    const res = await app.request(`http://evil.example/webfinger/jrd?${q('acct:alice@rs.example:8443')}`, { headers: spoofed }, createEnv());
    expect(await res.text()).not.toContain('evil.example');
  });

  it('/webfinger/xrd ignores Host', async () => {
    const res = await app.request('http://evil.example/webfinger/xrd', { headers: spoofed }, createEnv());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('evil.example');
    expect(text).toContain(`href="${BASE}/storage/alice"`);
  });

  it('host-meta ignores Host', async () => {
    const res = await app.request('http://evil.example/.well-known/host-meta', { headers: spoofed }, createEnv());
    const text = await res.text();
    expect(text).not.toContain('evil.example');
    expect(text).toContain('<hm:Host>rs.example:8443</hm:Host>');
    expect(text).toContain(`template="${BASE}/webfinger/jrd?resource={uri}"`);
  });

  it('/oauth/:user discovery JSON ignores Host', async () => {
    const res = await app.request('http://evil.example/oauth/alice', { headers: spoofed }, createEnv());
    const json = await res.json() as any;
    expect(json.www).toBe(BASE);
    expect(json.auth).toBe(`${BASE}/oauth/alice/authorize`);
    expect(json.token_endpoint).toBe(`${BASE}/oauth/alice/token`);
    expect(json.storageapi).toBe(`${BASE}/storage/alice`);
  });

  it('a trailing slash on PUBLIC_BASE_URL is ignored', async () => {
    const res = await app.request('http://localhost/oauth/alice', {}, createEnv({ PUBLIC_BASE_URL: `${BASE}/` }));
    const json = await res.json() as any;
    expect(json.storageapi).toBe(`${BASE}/storage/alice`);
  });
});

describe('OAuth is for the Account only', () => {
  const consent = 'client_id=https%3A%2F%2Fapp.example&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=token&scope=documents%3Arw';

  it('GET /oauth/:user/authorize returns 404 for another username', async () => {
    const res = await app.request(`http://localhost/oauth/bob/authorize?${consent}`, {}, createEnv());
    expect(res.status).toBe(404);
  });

  it('POST /oauth/:user/authorize returns 404 for another username', async () => {
    const res = await app.request('http://localhost/oauth/bob/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `${consent}&action=deny`,
    }, createEnv());
    expect(res.status).toBe(404);
  });

  it('POST /oauth/:user/token returns 404 for another username', async () => {
    const res = await app.request('http://localhost/oauth/bob/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'x', redirect_uri: 'https://app.example/cb' }),
    }, createEnv());
    expect(res.status).toBe(404);
  });

  it('GET /oauth/:user/authorize renders for the Account', async () => {
    const res = await app.request(`http://localhost/oauth/alice/authorize?${consent}`, {}, createEnv());
    expect(res.status).toBe(200);
  });
});

describe('Storage serves only the Account', () => {
  function storageEnv() {
    const env = createEnv();
    env.STORAGE.get = async () => ({ body: new TextEncoder().encode('hi').buffer, metadata: { contentType: 'text/plain', contentLength: 2, etag: '"e"' } });
    return env;
  }

  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    it(`${method} on another user's storage returns 404 even with that user's valid token`, async () => {
      const env = storageEnv();
      const token = seedToken(env, 'bob', 'documents:rw');

      const res = await app.request('http://localhost/storage/bob/documents/a.txt', {
        method,
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' },
        ...(method === 'PUT' ? { body: 'x' } : {}),
      }, env);

      expect(res.status).toBe(404);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
    });
  }

  it('anonymous /public/ reads of another user return 404', async () => {
    const res = await app.request('http://localhost/storage/bob/public/documents/a.txt', {}, storageEnv());
    expect(res.status).toBe(404);
  });

  it('other users are 404 without a token too, so they cannot be probed', async () => {
    const res = await app.request('http://localhost/storage/bob/documents/a.txt', {}, storageEnv());
    expect(res.status).toBe(404);
  });

  it('matches the Account username exactly, like the advertised storage root', async () => {
    const res = await app.request('http://localhost/storage/ALICE/public/documents/a.txt', {}, storageEnv());
    expect(res.status).toBe(404);
  });

  it("the Account's own storage is unchanged", async () => {
    const env = storageEnv();
    const token = seedToken(env, 'alice', 'documents:rw');

    const anonymous = await app.request('http://localhost/storage/alice/public/documents/a.txt', {}, env);
    const authed = await app.request('http://localhost/storage/alice/documents/a.txt', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    const noToken = await app.request('http://localhost/storage/alice/documents/a.txt', {}, env);

    expect(anonymous.status).toBe(200);
    expect(authed.status).toBe(200);
    expect(noToken.status).toBe(401);
  });
});

describe('Instance configuration', () => {
  const production = { RSILO_DEV_MODE: 'false' };

  it('outside dev mode, discovery refuses to answer without ACCOUNT_USERNAME and PUBLIC_BASE_URL', async () => {
    const env = { ...createEnv(production) } as any;
    delete env.ACCOUNT_USERNAME;
    delete env.PUBLIC_BASE_URL;

    const res = await app.request(`http://localhost/.well-known/webfinger?${q('acct:alice@localhost')}`, {}, env);

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain('ACCOUNT_USERNAME');
    expect(text).toContain('PUBLIC_BASE_URL');
  });

  it('outside dev mode, storage and OAuth refuse to answer without config', async () => {
    const env = { ...createEnv(production) } as any;
    delete env.PUBLIC_BASE_URL;

    const storage = await app.request('http://localhost/storage/alice/public/documents/x.txt', {}, env);
    const discovery = await app.request('http://localhost/oauth/alice', {}, env);
    const token = await app.request('http://localhost/oauth/alice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x' }),
    }, env);

    expect(storage.status).toBe(503);
    expect(discovery.status).toBe(503);
    expect(token.status).toBe(503);
  });

  it('outside dev mode, configured values are used', async () => {
    const res = await app.request('http://localhost/oauth/alice', {}, createEnv(production));
    expect(res.status).toBe(200);
  });

  it('in dev mode, defaults to alice at http://localhost:8787', async () => {
    const env = { ...createEnv() } as any;
    delete env.ACCOUNT_USERNAME;
    delete env.PUBLIC_BASE_URL;

    const res = await app.request(`http://localhost/.well-known/webfinger?${q('acct:alice@localhost:8787')}`, {}, env);

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(remoteStorageLink(json).href).toBe('http://localhost:8787/storage/alice');
  });

  for (const bad of ['not a url', 'ftp://rs.example', 'https://rs.example/sub/path', 'https://rs.example/?q=1']) {
    it(`rejects PUBLIC_BASE_URL=${bad} even in dev mode`, async () => {
      const res = await app.request('http://localhost/oauth/alice', {}, createEnv({ PUBLIC_BASE_URL: bad }));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('PUBLIC_BASE_URL');
    });
  }

  for (const bad of ['Alice', 'al/ice', '..']) {
    it(`rejects ACCOUNT_USERNAME=${bad}`, async () => {
      const res = await app.request('http://localhost/oauth/alice', {}, createEnv({ ACCOUNT_USERNAME: bad }));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('ACCOUNT_USERNAME');
    });
  }
});
