/**
 * The ONE place a WebDAV session's Authorization header is produced.
 *
 * This module must stay dependency-free (no Svelte / $app / webdav imports) —
 * it is used from web workers as well as the main thread.
 */
import { basicAuthHeader } from '$lib/util/base64';

/**
 * What a WebDAV session can authenticate with. `token` is a mokuro-bunko
 * bearer token (`POST /login/api/token`); `username`/`password` are the
 * account's Basic credentials, kept so a dead token can be replaced.
 */
export interface WebdavAuthMaterial {
  username?: string | null;
  password?: string | null;
  token?: string | null;
}

/**
 * THE Authorization header of a WebDAV session — every request to the WebDAV
 * server (the `webdav` client, identity, uploads, worker downloads, the OCR
 * queue) takes its header from here and nowhere else:
 *
 * - a held bearer token -> `Bearer <token>` (the password stays home);
 * - else a non-empty password -> UTF-8-safe `Basic` (see `basicAuthHeader`);
 *   a username without a password is NOT a credential (anonymous), and
 *   password-only auth (copyparty) is `Basic :pw`;
 * - else none: anonymous.
 *
 * Callers only ever send it to the WebDAV server's own origin.
 */
export function webdavAuthorization(auth: WebdavAuthMaterial): string | null {
  if (auth.token) return `Bearer ${auth.token}`;
  if (auth.password) return basicAuthHeader(auth.username ?? '', auth.password);
  return null;
}

/** `{ Authorization }` for `webdavAuthorization(auth)`, or `{}` when anonymous. */
export function webdavAuthHeaders(auth: WebdavAuthMaterial): Record<string, string> {
  const authorization = webdavAuthorization(auth);
  return authorization ? { Authorization: authorization } : {};
}

/** The bearer token an Authorization header carries, or null for any other header. */
export function bearerOf(authorization: string | null | undefined): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length).trim() || null;
}

/** The worker-credential spelling of a session's auth (`getWorker*Credentials`). */
export function authFromCredentials(credentials: Record<string, unknown>): WebdavAuthMaterial {
  const read = (key: string) =>
    typeof credentials[key] === 'string' ? (credentials[key] as string) : '';
  return {
    username: read('webdavUsername'),
    password: read('webdavPassword'),
    token: read('webdavToken')
  };
}
