// Single byte ranges on GET (RFC 9110 §14). Anything else (multiple ranges,
// other units, syntactically invalid values) is ignored and answered with
// the full document, which RFC 9110 permits.

export interface ByteRange { offset: number; length: number }

/**
 * Parses a Range header against a document of `size` bytes. Returns the
 * range to serve, 'unsatisfiable' (416) or null (ignore the header).
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;

  if (first === '') {
    // suffix range: the last N bytes
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    const offset = Math.max(size - n, 0);
    return { offset, length: size - offset };
  }

  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return { offset: start, length: end - start + 1 };
}

/** The Content-Range value for a served range of a document of `size` bytes. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
}
