import { AuthType, type WebDAVClientOptions } from 'webdav';
import { webdavAuthorization } from './webdav-authorization';

export {
  webdavAuthorization,
  webdavAuthHeaders,
  bearerOf,
  authFromCredentials,
  type WebdavAuthMaterial
} from './webdav-authorization';

/**
 * Limits on XML entities a WebDAV response DECLARES in its own DOCTYPE.
 *
 * Since 5.10 the webdav library sets no entity-expansion limit of its own
 * ("defaults to unlimited, again") and leaves whatever fast-xml-parser's
 * internal defaults happen to be — no count limit today. A hostile or
 * compromised server could answer a PROPFIND with a declared entity referenced
 * over and over and stall the tab or the sync worker; pinning the limits here
 * keeps them across dependency bumps. Only declared entities count (the
 * decoder's default `external` tier): `&amp;` and numeric references, which
 * real listings use, are never limited. No real WebDAV server declares
 * entities at all; the numbers are fast-xml-parser's own pre-5.7 defaults.
 *
 * Side effect: with a decoder configured, numeric character references
 * (`&#x65E5;`) in a response are decoded, as XML requires; the default parse
 * left them as literal text, which named a path that does not exist.
 *
 * Not covered: `client.lock()` — webdav parses LOCK responses with a separate
 * parser that never receives `entityDecoder`. The reader never takes locks;
 * a caller that starts to must not rely on these limits.
 */
export const WEBDAV_ENTITY_LIMITS = {
  limit: { maxTotalExpansions: 1000, maxExpandedLength: 100_000 }
} as const satisfies NonNullable<WebDAVClientOptions['entityDecoder']>;

/**
 * Build webdav `createClient` options with the session's Authorization header
 * and the entity limits above (an `extra.entityDecoder` overrides them; an
 * `entityDecoder: undefined` in `extra` keeps them — turning the limits off
 * takes an explicit decoder, never a missing value).
 *
 * The webdav library's own Basic-auth encoder (the `base-64` package) encodes
 * credentials as Latin-1: it throws on characters above U+00FF and produces
 * Latin-1 bytes for U+0080-U+00FF, which many servers (including mokuro-bunko)
 * cannot match against UTF-8-derived password hashes. We therefore always use
 * `AuthType.None` (Password/Auto would overwrite `headers.Authorization` with
 * the lib's encoder) and pass a pre-built header instead.
 *
 * Header rule: `webdavAuthorization` — Bearer when a token is held, else Basic
 * iff `password` is non-empty, else none. A username without a password sends
 * NO header (anonymous), so a cleared password yields truly anonymous requests
 * on the main thread and in workers.
 */
export function webdavAuthOptions(
  username?: string,
  password?: string,
  extra: WebDAVClientOptions = {},
  token?: string | null
): WebDAVClientOptions {
  const authorization = webdavAuthorization({ username, password, token });
  const base: WebDAVClientOptions = {
    ...extra,
    entityDecoder: extra.entityDecoder ?? WEBDAV_ENTITY_LIMITS
  };
  if (!authorization) {
    return { ...base, authType: AuthType.None };
  }
  return {
    ...base,
    authType: AuthType.None,
    headers: { ...(extra.headers ?? {}), Authorization: authorization }
  };
}
