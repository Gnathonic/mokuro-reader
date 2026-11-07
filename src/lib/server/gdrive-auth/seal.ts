/**
 * The session cookie's sealed value: `v1.<kid>.<iv>.<ciphertext||tag>`, each
 * part base64url, AES-256-GCM with a fresh random 12-byte IV per seal and a
 * 16-byte tag. The additional data binds the value to where it may be used:
 * `v1|<kid>|<client_id>|<origin>|<cookie name>`. A cookie minted for another
 * deployment (another origin), another Google client or under the other cookie
 * name therefore never opens here, even under the same key. The origin always
 * comes from the request URL (`event.url.origin`), never from configuration or
 * a request header.
 *
 * Never put anything about the CLIENT (IP, user agent, a device secret) into
 * the key or the additional data: a mismatch would make the cookie
 * undecryptable, and logout could then no longer revoke its token at Google.
 * Device binding is a sealed POLICY field instead (`cnf`, checked by `pop.ts`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from './bytes';
import type { AuthConfig, SessionKey } from './config';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session unused this long is dead (`ts`). */
export const SESSION_MAX_IDLE_MS = 180 * DAY_MS;
/** No session outlives its first consent by more than this (`iat0`). */
export const SESSION_MAX_AGE_MS = 365 * DAY_MS;
/** `ts` (and the cookie's Max-Age) slide forward at most this often. */
export const RESEAL_AFTER_MS = 7 * DAY_MS;
/** Browsers drop a cookie whose name and value exceed ~4096 bytes, silently. */
export const COOKIE_MAX_BYTES = 4000;
/** Longest refresh token we accept (Google's are ~100 characters); the cookie size guard is the real limit. */
const MAX_REFRESH_TOKEN_LENGTH = 4096;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

export interface SessionPayload {
  /** Google's refresh token. */
  rt: string;
  /** First consent (ms since the epoch). Never changes for the life of the session. */
  iat0: number;
  /** Last (re-)seal (ms since the epoch). */
  ts: number;
  /** RFC 7638 SHA-256 thumbprint of the device key the session is bound to. */
  cnf?: string;
}

/** Where a sealed value may be opened: the additional data's inputs. */
export interface SealContext {
  clientId: string;
  origin: string;
  cookieName: string;
}

export class SealTooLargeError extends Error {
  constructor() {
    super('sealed session would exceed the cookie size limit');
    this.name = 'SealTooLargeError';
  }
}

function additionalData(kid: string, context: SealContext): Uint8Array {
  return utf8(`${VERSION}|${kid}|${context.clientId}|${context.origin}|${context.cookieName}`);
}

export function seal(payload: SessionPayload, key: SessionKey, context: SealContext): string {
  if (!isSessionPayload(payload)) throw new Error('refusing to seal a malformed session');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.raw, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(key.kid, context));
  const body = concatBytes(
    cipher.update(utf8(JSON.stringify(payload))),
    cipher.final(),
    cipher.getAuthTag()
  );
  const value = `${VERSION}.${key.kid}.${toBase64Url(iv)}.${toBase64Url(body)}`;
  if (context.cookieName.length + 1 + value.length > COOKIE_MAX_BYTES) {
    throw new SealTooLargeError();
  }
  return value;
}

export type UnsealFailure = 'malformed' | 'unknown_kid' | 'bad_tag' | 'bad_payload';

export type Unsealed =
  | { ok: true; payload: SessionPayload; sealedWith: 'current' | 'previous' }
  | { ok: false; reason: UnsealFailure };

/** Open a sealed value with whichever configured key its kid names. */
export function unseal(
  value: string,
  keys: Pick<AuthConfig, 'current' | 'previous'>,
  context: SealContext
): Unsealed {
  if (value.length > COOKIE_MAX_BYTES) return { ok: false, reason: 'malformed' };
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, kid, ivText, bodyText] = parts;

  const sealedWith =
    kid === keys.current.kid ? 'current' : kid === keys.previous?.kid ? 'previous' : null;
  if (!sealedWith) return { ok: false, reason: 'unknown_kid' };
  const key = sealedWith === 'current' ? keys.current : keys.previous!;

  const iv = fromBase64Url(ivText);
  const body = fromBase64Url(bodyText);
  if (!iv || iv.length !== IV_BYTES || !body || body.length <= TAG_BYTES) {
    return { ok: false, reason: 'malformed' };
  }

  let plaintext: Uint8Array;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.raw, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(kid, context));
    decipher.setAuthTag(body.slice(body.length - TAG_BYTES));
    plaintext = concatBytes(
      decipher.update(body.slice(0, body.length - TAG_BYTES)),
      decipher.final()
    );
  } catch {
    return { ok: false, reason: 'bad_tag' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!isSessionPayload(payload)) return { ok: false, reason: 'bad_payload' };
  return {
    ok: true,
    payload: {
      rt: payload.rt,
      iat0: payload.iat0,
      ts: payload.ts,
      ...(payload.cnf ? { cnf: payload.cnf } : {})
    },
    sealedWith
  };
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  const p = value as Partial<SessionPayload> | null;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.rt === 'string' &&
    p.rt.length > 0 &&
    p.rt.length <= MAX_REFRESH_TOKEN_LENGTH &&
    isStamp(p.iat0) &&
    isStamp(p.ts) &&
    (p.cnf === undefined || (typeof p.cnf === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p.cnf)))
  );
}

/**
 * Is the session past its server-side lifetime? Checked on the SEALED stamps:
 * the cookie's Max-Age only binds honest browsers, and a copied cookie
 * replayed from a script would otherwise live forever.
 */
export function sessionExpired(payload: SessionPayload, now: number): boolean {
  return now - payload.ts > SESSION_MAX_IDLE_MS || now - payload.iat0 > SESSION_MAX_AGE_MS;
}

/**
 * Should a successful use write the cookie again? When it was opened with the
 * previous key (rotate it onto the current one), or when `ts` is over a week
 * old (slide the idle window). Not on every use: that would be a Set-Cookie
 * per hourly refresh for nothing. Sliding never extends `iat0`, so whoever
 * keeps using a cookie — its owner or someone replaying a copy — gets at most
 * SESSION_MAX_AGE_MS from the first consent.
 */
export function needsReseal(
  unsealed: { payload: SessionPayload; sealedWith: 'current' | 'previous' },
  now: number
): boolean {
  return unsealed.sealedWith === 'previous' || now - unsealed.payload.ts > RESEAL_AFTER_MS;
}
