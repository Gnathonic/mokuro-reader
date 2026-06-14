import { AuthType, type WebDAVClientOptions } from 'webdav';
import { basicAuthHeader } from '$lib/util/base64';

/**
 * Build webdav `createClient` options with a UTF-8-safe Basic Authorization
 * header.
 *
 * The webdav library's own Basic-auth encoder (the `base-64` package) encodes
 * credentials as Latin-1: it throws on characters above U+00FF and produces
 * Latin-1 bytes for U+0080-U+00FF, which many servers (including mokuro-bunko)
 * cannot match against UTF-8-derived password hashes. We therefore always use
 * `AuthType.None` (Password/Auto would overwrite `headers.Authorization` with
 * the lib's encoder) and pass a pre-built header instead.
 *
 * Header rule: an Authorization header is built iff `password` is non-empty.
 * A username without a password sends NO header (anonymous), so a cleared
 * password yields truly anonymous requests on the main thread and in workers.
 * Password-only auth (e.g. copyparty) still works: `Basic :pw`.
 */
export function webdavAuthOptions(
  username?: string,
  password?: string,
  extra: WebDAVClientOptions = {}
): WebDAVClientOptions {
  if (!password) {
    return { ...extra, authType: AuthType.None };
  }
  return {
    ...extra,
    authType: AuthType.None,
    headers: { ...(extra.headers ?? {}), Authorization: basicAuthHeader(username ?? '', password) }
  };
}
