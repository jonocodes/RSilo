// PROTOTYPE — throwaway. Two BlobStores: a local directory and Dropbox.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BlobStore } from './indexed-storage';

export class DirBlobStore implements BlobStore {
  constructor(private dir: string) {}

  async put(id: string, body: ArrayBuffer) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, id), new Uint8Array(body));
  }

  async get(id: string, range?: { offset: number; length: number }) {
    const bytes = await readFile(join(this.dir, id));
    const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
  }

  async deleteMany(ids: string[]) {
    await Promise.all(ids.map((id) => rm(join(this.dir, id), { force: true })));
  }
}

/** The current request's Dropbox calls, timed, so a run can report calls per request. */
export const dropboxCalls = new AsyncLocalStorage<{ op: string; ms: number; status: number }[]>();

// Each operation is one HTTP call, and every body passes through as-is: a
// download's response body is returned untouched, the way a Worker would stream it.
export class DropboxBlobStore implements BlobStore {
  constructor(private token: string, private root = '/rsilo-blobs') {}

  private async call(op: string, url: string, init: RequestInit): Promise<Response> {
    const start = performance.now();
    for (;;) {
      const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
      dropboxCalls.getStore()?.push({ op, ms: Math.round(performance.now() - start), status: response.status });
      if (response.status === 429) {
        const wait = Number(response.headers.get('Retry-After') ?? '1');
        await response.body?.cancel();
        console.log(`[dropbox] ${op} 429, retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      return response;
    }
  }

  private async ok(op: string, response: Response) {
    if (!response.ok) throw new Error(`Dropbox ${op} ${response.status}: ${await response.text()}`);
  }

  async put(id: string, body: ArrayBuffer) {
    const response = await this.call('upload', 'https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: `${this.root}/${id}`, mode: 'add', mute: true }),
      },
      body,
    });
    await this.ok('upload', response);
    await response.body?.cancel();
  }

  async get(id: string, range?: { offset: number; length: number }) {
    const response = await this.call('download', 'https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: `${this.root}/${id}` }),
        ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}),
      },
    });
    await this.ok('download', response);
    return response.body!;
  }

  // One delete_batch for all of them. Dropbox runs it as an async job, polled
  // here until done; entries that are already gone come back as failures, which is fine.
  async deleteMany(ids: string[]) {
    const response = await this.call('delete_batch', 'https://api.dropboxapi.com/2/files/delete_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: ids.map((id) => ({ path: `${this.root}/${id}` })) }),
    });
    await this.ok('delete_batch', response);
    let result = await response.json() as { '.tag': string; async_job_id?: string };
    const jobId = result.async_job_id;
    while (result['.tag'] === 'async_job_id' || result['.tag'] === 'in_progress') {
      await new Promise((r) => setTimeout(r, 1000));
      const check = await this.call('delete_batch/check', 'https://api.dropboxapi.com/2/files/delete_batch/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ async_job_id: jobId }),
      });
      await this.ok('delete_batch/check', check);
      result = await check.json() as { '.tag': string };
    }
    if (result['.tag'] === 'failed') throw new Error(`Dropbox delete_batch failed: ${JSON.stringify(result)}`);
  }
}
