// Item names (draft-dejong-remotestorage §4): "Item names MAY contain all
// characters, before URI_ENCODE, except '/' and the null character '\0' and
// MUST NOT have zero length. Item names MUST NOT be equal to '.' or to '..'."
//
// Requests carry each name percent-encoded, so a path is decoded segment by
// segment from the raw URL. Decoding the whole path first (as Hono's
// c.req.path does, with decodeURI semantics) loses the difference between
// "a%2Fb" and "a/b" and leaves reserved characters such as "?" or "#"
// encoded, so the stored name would not be the name the client sent.

/** Whether a decoded item name is allowed. */
export function isValidItemName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

/**
 * Decodes a raw (percent-encoded) path below the storage root, e.g.
 * "documents/a%20b%3F/c.txt" or "documents/notes/". Returns the path of
 * decoded names, keeping a trailing "/" for folders, or null if a segment is
 * malformed or not a valid item name. "" (the root) stays "".
 */
export function decodeItemPath(rawPath: string): string | null {
  if (rawPath === '') return '';
  const isFolder = rawPath.endsWith('/');
  const segments = (isFolder ? rawPath.slice(0, -1) : rawPath).split('/');
  const names: string[] = [];
  for (const segment of segments) {
    let name: string;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!isValidItemName(name)) return null;
    names.push(name);
  }
  return names.join('/') + (isFolder ? '/' : '');
}

/** Percent-encodes each name of a decoded path, for building URLs. */
export function encodeItemPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The request path exactly as sent, still percent-encoded. Used as Hono's
 * getPath so routing never sees decoded characters: an encoded newline would
 * otherwise stop "*" (".*") from matching, and handlers decode names
 * themselves with decodeItemPath.
 */
export function rawRequestPath(request: Request): string {
  const url = request.url;
  const start = url.indexOf('/', url.indexOf('://') + 3);
  if (start === -1) return '/';
  const query = url.indexOf('?', start);
  return url.slice(start, query === -1 ? undefined : query);
}
