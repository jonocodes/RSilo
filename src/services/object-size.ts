export const DEFAULT_MAX_OBJECT_SIZE_BYTES = 10 * 1024 * 1024;

export class ObjectTooLargeError extends Error {}

export function maxObjectSize(env: unknown): number {
  const configured = typeof env === 'object' && env !== null
    ? Number((env as { MAX_OBJECT_SIZE_BYTES?: string }).MAX_OBJECT_SIZE_BYTES)
    : NaN;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_OBJECT_SIZE_BYTES;
}

export function rejectOversizedContentLength(request: Request, maximum: number, overhead = 0): void {
  const value = request.headers.get('Content-Length');
  if (!value) return;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum + overhead) {
    throw new ObjectTooLargeError(`Object exceeds the ${maximum}-byte limit`);
  }
}

export async function readRequestBody(request: Request, maximum: number): Promise<ArrayBuffer> {
  rejectOversizedContentLength(request, maximum);
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ObjectTooLargeError(`Object exceeds the ${maximum}-byte limit`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
