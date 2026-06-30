/**
 * Pure helpers for MEGA session-token auth: error classification, session-blob
 * sanitization, and per-file key encoding for worker transport.
 *
 * No side effects, no DOM, no megajs imports — safe to unit test in isolation.
 */

/** Sanitized megajs `Storage.toJSON()` blob persisted under localStorage['mega_session']. */
export interface MegaSessionBlob {
  /** Account master key (base64url) — sensitive. */
  key: string;
  /** Session id. */
  sid: string;
  name?: string;
  user?: string;
  /** megajs options minus password/secondFactorCode. */
  options?: Record<string, any>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** MEGA signals "2FA code required" only via the EMFAREQUIRED (-26) error message. */
export function isMfaRequiredError(error: unknown): boolean {
  return /EMFAREQUIRED|Multi-Factor|-26/i.test(messageOf(error));
}

/** MEGA signals an invalid/expired session via ESID (-15). */
export function isSessionExpiredError(error: unknown): boolean {
  return /ESID|-15|expired user session|please relogin/i.test(messageOf(error));
}

/** Genuine credential rejection (wrong email/password) vs transient/network errors. */
export function isAuthRejectionError(error: unknown): boolean {
  return /ENOENT|incorrect|invalid|authentication failed|wrong password/i.test(messageOf(error));
}

/** Strip single-use / sensitive fields from a `toJSON()` blob before persisting. */
export function sanitizeSessionBlob(blob: any): MegaSessionBlob {
  const options = { ...(blob?.options ?? {}) };
  delete options.password;
  delete options.secondFactorCode;
  return { key: blob.key, sid: blob.sid, name: blob.name, user: blob.user, options };
}

/**
 * Encode a raw MEGA key buffer to MEGA's base64url ("e64") form so a worker's
 * `formatKey` (d64) reconstructs the identical megajs Buffer.
 */
export function encodeMegaKey(key: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < key.length; i++) binary += String.fromCharCode(key[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
