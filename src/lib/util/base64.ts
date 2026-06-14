/**
 * UTF-8-safe base64 helpers.
 *
 * `btoa()` encodes its input as Latin-1 and throws on characters above U+00FF,
 * which silently corrupts (or breaks) Basic-auth credentials containing
 * non-ASCII characters. These helpers always encode through UTF-8 bytes.
 *
 * This module must stay dependency-free (no Svelte / $app imports) — it is
 * used from web workers as well as the main thread.
 */

export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build an RFC 7617 Basic Authorization header value with UTF-8 encoded
 * credentials (matching `charset="UTF-8"` servers).
 */
export function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + utf8ToBase64(`${username}:${password}`);
}
