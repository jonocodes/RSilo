import { normalizeETag } from '../protocol/constants';
import type { WriteCondition } from '../types';

/** A write's condition (StorageInterface put/delete) did not hold: answered with 412. */
export class PreconditionFailedError extends Error {
  constructor() {
    super('Precondition Failed');
  }
}

/** A document and a folder would share a name (remoteStorage's 409). */
export class PathConflictError extends Error {
  constructor() {
    super('Conflict: a document and a folder cannot share a name');
  }
}

/** Whether `current` (a head() result, or null when absent) satisfies `condition`. */
export function conditionHolds(current: { etag: string } | null, condition: WriteCondition | undefined): boolean {
  if (!condition) return true;
  if (condition.ifNoneMatch === '*' && current) return false;
  if (condition.ifMatch !== undefined) {
    return current !== null && normalizeETag(current.etag) === normalizeETag(condition.ifMatch);
  }
  return true;
}
