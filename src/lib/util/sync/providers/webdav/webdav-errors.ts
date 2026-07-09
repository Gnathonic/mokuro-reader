/**
 * Pure classification of WebDAV write-failure messages.
 *
 * 401 means the credentials were rejected (an auth problem, NOT a read-only
 * server), 403 means the authenticated user lacks permission for this
 * operation, and 405 means the server genuinely does not allow the method
 * (read-only share). Callers map these kinds onto provider policy.
 */
export type WriteErrorKind = 'auth' | 'permission' | 'readonly' | 'other';

export function classifyWriteError(message: string): WriteErrorKind {
  // First match wins: auth outranks permission outranks readonly.
  if (/\b401\b|Unauthorized/i.test(message)) return 'auth';
  if (/\b403\b|Forbidden|Permission denied/i.test(message)) return 'permission';
  if (/\b405\b|Method Not Allowed/i.test(message)) return 'readonly';
  return 'other';
}
