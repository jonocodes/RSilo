import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

// Regenerates the README screenshots in docs/images/. Starts a throwaway
// offline server on a temp directory, seeds sample files, connects three apps
// through the real consent page, then captures the dashboard and the file
// manager. Uses the Chromium from `bunx playwright install chromium`, or
// CHROME_PATH where that one will not launch (see docs/development.md).

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const OUT = 'docs/images';
const WIDTH = 1000;

const dir = mkdtempSync(join(tmpdir(), 'rsilo-screenshots-'));
const env = {
  ...process.env,
  DB_PATH: join(dir, 'remotestorage.db'),
  STORAGE_DIR: join(dir, 'storage'),
  PORT: String(PORT),
  // Only changes the advertised addresses, so the dashboard shows a realistic storage address.
  PUBLIC_BASE_URL: 'https://rsilo.alice.workers.dev',
};
const server = spawn('bun', ['src/server-offline.ts'], { env, stdio: 'ignore' });

try {
  await waitForServer();
  const token = spawnSync('bun', ['src/scripts/dev-token.ts', 'alice', '*:rw'], { env, encoding: 'utf8' }).stdout.trim();
  await seed(token);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 2 });
  page.on('dialog', (dialog) => void dialog.accept());
  // The apps' redirect targets are not reachable here; answer them with a blank page.
  await page.route(/^https:\/\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));

  await connectApps(page);
  // Drop the seeding token so only the connected apps are listed.
  await page.goto(`${BASE}/account`);
  await page.locator('form[data-confirm-message*="dev-token"] button').click();
  await page.waitForLoadState('load');

  await page.goto(`${BASE}/account`);
  const publicFiles = await page.locator('h2', { hasText: 'Public files' }).boundingBox();
  await shotTo(page, 'dashboard.png', publicFiles!.y - 8);

  await page.goto(`${BASE}/account/browse/documents`);
  const files = await page.locator('table').first().locator('xpath=ancestor::*[contains(@class,"card")][1]').boundingBox();
  await shotTo(page, 'files.png', files!.y + files!.height + 32);

  await browser.close();
  console.log(`Screenshots written to ${OUT}/`);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Offline server did not start on ${BASE}`);
}

function shotTo(page: Page, name: string, bottom: number) {
  return page.screenshot({ path: `${OUT}/${name}`, clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(bottom) } });
}

function consentQuery(origin: string, scope: string): string {
  return new URLSearchParams({ client_id: origin, redirect_uri: `${origin}/`, response_type: 'token', scope, state: 's' }).toString();
}

async function connectApps(page: Page): Promise<void> {
  const apps = [
    ['https://litewrite.net', 'documents:rw'],
    ['https://webmarks.5apps.com', 'bookmarks:rw'],
    ['https://savr.link', 'savr:rw'],
  ];
  for (const [origin, scope] of apps) {
    await page.goto(`${BASE}/account/oauth/authorize?${consentQuery(origin, scope)}`);
    await page.click('button[value="approve"]');
    await page.waitForURL((url) => url.origin === origin);
  }
}

async function seed(token: string): Promise<void> {
  const photo = (sky: string, sun: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#1d3557"/></linearGradient></defs>`
    + `<rect width="640" height="400" fill="url(#g)"/><circle cx="${sun}" cy="120" r="50" fill="#fff8e1"/>`
    + '<path d="M0 400 L180 220 L320 330 L460 200 L640 360 L640 400 Z" fill="#0b2239"/></svg>';
  const files: [string, string, string][] = [
    ['documents/notes/grocery-list.md', 'text/markdown', '# Groceries\n\n- oat milk\n- sourdough\n- tomatoes\n'],
    ['documents/notes/book-ideas.md', 'text/markdown', '# Book ideas\n\n1. A lighthouse keeper who syncs her logbook.\n'],
    ['documents/recipes/focaccia.md', 'text/markdown', '# Rosemary focaccia\n\n500 g flour, 400 g water, 10 g salt, 4 g yeast.\n'],
    ['documents/trip-plan.txt', 'text/plain', 'Lisbon, May 2027\n- Day 1: Alfama, tram 28\n- Day 2: Belém\n- Day 3: Sintra\n'],
    ['tasks/todos.json', 'application/json', JSON.stringify({ items: [{ title: 'Fix bike brakes', done: true }] })],
    ['bookmarks/links.json', 'application/json', JSON.stringify({ links: [{ url: 'https://remotestorage.io' }] })],
    ['pictures/2026-10-hike/ridge.svg', 'image/svg+xml', photo('#f6a04d', 150)],
    ['pictures/2026-10-hike/lake.svg', 'image/svg+xml', photo('#4d9df6', 450)],
    ['public/documents/focaccia-recipe.md', 'text/markdown', '# Rosemary focaccia (shared)\n'],
  ];
  for (const [path, type, body] of files) {
    const res = await fetch(`${BASE}/storage/alice/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
      body,
    });
    if (!res.ok) throw new Error(`Seeding ${path} failed: ${res.status}`);
  }
}
