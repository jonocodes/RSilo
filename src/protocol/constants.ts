// RemoteStorage protocol version
export const PROTOCOL_VERSION = 'draft-dejong-remotestorage-22';

// RemoteStorage folder listing MIME type
export const FOLDER_MIME_TYPE = 'application/ld+json; charset=utf-8';

// Empty folder structure per RemoteStorage spec
export interface FolderItem {
  '@context': 'http://remotestorage.io/spec/folder-description';
  items: Record<string, { ETag: string; 'Content-Type'?: string; 'Content-Length'?: number }>;
}

export function createEmptyFolder(): FolderItem {
  return {
    '@context': 'http://remotestorage.io/spec/folder-description',
    items: {},
  };
}

// Normalize ETag to always be quoted and lowercase
export function normalizeETag(etag: string | null | undefined): string | null {
  if (!etag) return null;

  // R2 may return weak ETags ("W/..."). remoteStorage expects strong, stable
  // validators, so we drop the weak prefix and always emit a quoted ETag.
  if (etag.startsWith('W/')) {
    etag = etag.slice(2);
  }

  if (!etag.startsWith('"')) {
    etag = '"' + etag;
  }
  if (!etag.endsWith('"')) {
    etag += '"';
  }

  return etag.toLowerCase();
}

// Strip quotes from ETag for comparison
export function stripQuotes(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

// Validate path - no empty segments, no dots, no null bytes
export function isValidPath(path: string): boolean {
  if (!path || path === '/') return true;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  if (trimmed.length === 0) return false;
  const segments = trimmed.split('/');
  return segments.every(s => s.length > 0 && !s.startsWith('.') && !s.includes('\0'));
}

// Generate ETag from content
export function generateETag(content: string): string {
  const hash = 0;
  return `"${content.length}-${hash}"`;
}

// Parse bearer token
export function parseAuthHeader(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}